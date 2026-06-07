import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Sandbox } from "../sandbox/types.js";
import type { RepoTarget } from "../sandbox/repo.js";
import type { Approver } from "../approvals/gate.js";
import { commitAndOpenPR } from "../git/committer.js";
import { queue } from "../queue/index.js";
import { slugify, clip } from "../util/text.js";

export interface DevToolContext {
  sandbox: Sandbox;
  target: RepoTarget;
  /** Como pedir aprovação (Slack em produção, terminal em smoke test). */
  approve: Approver;
  /** Thread onde o trabalho acontece (para acionar o QA depois do PR). */
  thread?: { channel: string; threadTs: string; threadKey: string };
}

export function devTools(ctx: DevToolContext): ToolSet {
  const { sandbox, target, approve, thread } = ctx;

  return {
    sandbox_run: tool({
      description:
        "Executa um comando de shell no sandbox, dentro do repositório clonado (ex.: rodar testes, listar arquivos, build).",
      inputSchema: z.object({
        command: z.string().describe("Comando de shell (ex.: 'npm test', 'ls src')."),
      }),
      execute: async ({ command }) => {
        const res = await sandbox.run(command, { cwd: sandbox.repoDir, timeoutMs: 180_000 });
        return { exitCode: res.exitCode, stdout: clip(res.stdout), stderr: clip(res.stderr) };
      },
    }),

    sandbox_read_file: tool({
      description: "Lê um arquivo do repositório (caminho relativo à raiz do repo).",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        try {
          const content = await sandbox.readFile(`${sandbox.repoDir}/${path}`);
          return { path, content: clip(content, 12_000) };
        } catch (err) {
          return { path, error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),

    sandbox_write_file: tool({
      description: "Escreve/sobrescreve um arquivo do repositório (caminho relativo à raiz do repo).",
      inputSchema: z.object({
        path: z.string(),
        content: z.string().describe("Conteúdo completo do arquivo."),
      }),
      execute: async ({ path, content }) => {
        await sandbox.writeFile(`${sandbox.repoDir}/${path}`, content);
        return { ok: true, path };
      },
    }),

    request_pr_approval: tool({
      description:
        "PONTO-CHAVE: pede aprovação humana no Slack para abrir o Pull Request. Só chame quando a implementação estiver pronta e os testes passando. Se aprovado, commita, faz push e abre o PR.",
      inputSchema: z.object({
        title: z.string().describe("Título do PR / mensagem de commit."),
        body: z.string().describe("Descrição do PR em Markdown: o que mudou e por quê."),
        summary: z
          .string()
          .describe("Resumo curto (1-3 linhas) para a mensagem de aprovação no Slack."),
      }),
      execute: async ({ title, body, summary }) => {
        const decision = await approve({
          text: `*Pronto para abrir PR* — ${summary}\n\n*${title}*\n\nPosso abrir o Pull Request?`,
        });

        if (!decision.approved) {
          return {
            approved: false,
            feedback: decision.feedback ?? "PR recusado pelo humano. Reavalie a abordagem.",
          };
        }

        const branch = `agent/${slugify(title)}-${Date.now().toString(36)}`;

        // O commit + PR são feitos no HOST a partir do diff do sandbox (token nunca entra
        // no sandbox para escrita). Ver src/git/committer.ts.
        let pr: { url: string; number: number };
        try {
          pr = await commitAndOpenPR({ sandbox, target, branch, title, body });
        } catch (err) {
          return { approved: true, pushed: false, error: err instanceof Error ? err.message : String(err) };
        }

        // Aciona o QA para revisar o PR (handoff Dev → QA).
        if (thread) {
          await queue.enqueue("qa-review", {
            channel: thread.channel,
            threadTs: thread.threadTs,
            threadKey: thread.threadKey,
            repo: `${target.owner}/${target.repo}`,
            branch,
            prUrl: pr.url,
            prNumber: pr.number,
            title,
          });
        }

        return { approved: true, pushed: true, branch, prUrl: pr.url };
      },
    }),
  };
}

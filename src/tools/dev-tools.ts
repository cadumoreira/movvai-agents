import type { Sandbox } from "e2b";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { config } from "../config.js";
import type { AgentContext } from "../agents/context.js";
import { REPO_DIR, type RepoTarget } from "../sandbox/e2b.js";
import { requestApproval } from "../approvals/gate.js";
import { openPullRequest } from "./github-write.js";

export interface DevToolContext {
  sandbox: Sandbox;
  target: RepoTarget;
  agent: AgentContext;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Limita o tamanho de saídas para conter contexto/custo. */
function clip(s: string, max = 8_000): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncado)" : s;
}

export function devTools(ctx: DevToolContext): ToolSet {
  const { sandbox, target, agent } = ctx;

  return {
    sandbox_run: tool({
      description:
        "Executa um comando de shell no sandbox, dentro do repositório clonado (ex.: rodar testes, listar arquivos, build).",
      inputSchema: z.object({
        command: z.string().describe("Comando de shell (ex.: 'npm test', 'ls src')."),
      }),
      execute: async ({ command }) => {
        const res = await sandbox.commands.run(command, { cwd: REPO_DIR, timeoutMs: 180_000 });
        return { exitCode: res.exitCode, stdout: clip(res.stdout), stderr: clip(res.stderr) };
      },
    }),

    sandbox_read_file: tool({
      description: "Lê um arquivo do repositório (caminho relativo à raiz do repo).",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        try {
          const content = await sandbox.files.read(`${REPO_DIR}/${path}`);
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
        await sandbox.files.write(`${REPO_DIR}/${path}`, content);
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
        const decision = await requestApproval(agent.slack, {
          channel: agent.channel,
          threadTs: agent.threadTs,
          text: `*Pronto para abrir PR* — ${summary}\n\n*${title}*\n\nPosso abrir o Pull Request?`,
        });

        if (!decision.approved) {
          return {
            approved: false,
            feedback: decision.feedback ?? "PR recusado pelo humano. Reavalie a abordagem.",
          };
        }

        const branch = `agent/${slugify(title)}-${Date.now().toString(36)}`;
        const token = config.github.token;
        const remote = `https://x-access-token:${token}@github.com/${target.owner}/${target.repo}.git`;

        const script = [
          `git checkout -b ${branch}`,
          `git add -A`,
          `git commit -m ${JSON.stringify(title)}`,
          `git remote set-url origin ${remote}`,
          `git push -u origin ${branch}`,
        ].join(" && ");

        const push = await sandbox.commands.run(script, { cwd: REPO_DIR, timeoutMs: 180_000 });
        if (push.exitCode !== 0) {
          return { approved: true, pushed: false, error: clip(push.stderr) };
        }

        const prUrl = await openPullRequest(target, { head: branch, title, body });
        return { approved: true, pushed: true, branch, prUrl };
      },
    }),
  };
}

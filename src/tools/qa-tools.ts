import type { Sandbox } from "e2b";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { REPO_DIR, type RepoTarget } from "../sandbox/e2b.js";
import { commentOnPullRequest } from "./github-write.js";
import { clip } from "../util/text.js";

export interface QaToolContext {
  sandbox: Sandbox;
  target: RepoTarget;
  prNumber: number;
}

export function qaTools(ctx: QaToolContext): ToolSet {
  const { sandbox, target, prNumber } = ctx;

  return {
    sandbox_run: tool({
      description: "Executa um comando de shell no repositório (ex.: rodar testes, lint, git diff).",
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) => {
        const res = await sandbox.commands.run(command, { cwd: REPO_DIR, timeoutMs: 180_000 });
        return { exitCode: res.exitCode, stdout: clip(res.stdout), stderr: clip(res.stderr) };
      },
    }),

    sandbox_read_file: tool({
      description: "Lê um arquivo do repositório (caminho relativo à raiz).",
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

    comment_on_pr: tool({
      description:
        "Registra a revisão como comentário no PR. Use no final, com o veredito (aprovado/mudanças necessárias) e os pontos encontrados.",
      inputSchema: z.object({
        approved: z.boolean().describe("true se o PR está bom para merge; false se precisa de mudanças."),
        summary: z.string().describe("Resumo curto do veredito."),
        details: z.string().describe("Detalhes em Markdown: testes, riscos, sugestões."),
      }),
      execute: async ({ approved, summary, details }) => {
        const verdict = approved ? "✅ Aprovado pelo QA" : "🔧 Mudanças necessárias";
        const body = `## Revisão automática (QA)\n\n**${verdict}** — ${summary}\n\n${details}`;
        await commentOnPullRequest(target, prNumber, body);
        return { ok: true, approved };
      },
    }),
  };
}

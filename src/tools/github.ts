import { Octokit } from "@octokit/rest";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { config } from "../config.js";

/**
 * Ferramentas de LEITURA do GitHub para o PM investigar o repositório.
 * Fase 0 é só leitura — escrita (branch/PR) entra na Fase 1 com o agente Dev.
 *
 * Nota de segurança: o conteúdo retornado (código, READMEs) é entrada NÃO confiável.
 * Ele entra no contexto do modelo, então mantenha o PM sem ferramentas destrutivas.
 */
export function githubTools(): ToolSet {
  if (!config.github.token) return {};
  const octokit = new Octokit({ auth: config.github.token });

  const repoArg = z
    .string()
    .optional()
    .describe(
      `Repositório no formato "owner/repo". Se omitido, usa o padrão (${config.github.defaultRepo || "nenhum configurado"}).`,
    );

  function splitRepo(repo?: string): { owner: string; repo: string } {
    const full = repo || config.github.defaultRepo;
    if (!full) throw new Error("Nenhum repositório informado nem GITHUB_DEFAULT_REPO definido.");
    const [owner, name] = full.split("/");
    if (!owner || !name) throw new Error(`Repositório inválido: "${full}". Use "owner/repo".`);
    return { owner, repo: name };
  }

  return {
    github_search_code: tool({
      description:
        "Busca trechos de código no repositório por palavra-chave (ex.: nome de função, mensagem de erro). Use para localizar onde um bug pode estar.",
      inputSchema: z.object({
        query: z.string().describe("Termo de busca (ex.: 'resetToken', 'password reset')."),
        repo: repoArg,
      }),
      execute: async ({ query, repo }) => {
        const { owner, repo: name } = splitRepo(repo);
        const res = await octokit.rest.search.code({
          q: `${query} repo:${owner}/${name}`,
          per_page: 5,
        });
        return {
          total: res.data.total_count,
          results: res.data.items.map((i) => ({ path: i.path, url: i.html_url })),
        };
      },
    }),

    github_read_file: tool({
      description: "Lê o conteúdo de um arquivo do repositório por caminho.",
      inputSchema: z.object({
        path: z.string().describe("Caminho do arquivo (ex.: 'src/auth/reset.ts')."),
        repo: repoArg,
      }),
      execute: async ({ path, repo }) => {
        const { owner, repo: name } = splitRepo(repo);
        const res = await octokit.rest.repos.getContent({ owner, repo: name, path });
        if (Array.isArray(res.data) || res.data.type !== "file") {
          return { error: "Caminho não é um arquivo." };
        }
        const content = Buffer.from(res.data.content, "base64").toString("utf-8");
        // Trunca para não estourar contexto/custo em arquivos enormes.
        const max = 12_000;
        return {
          path,
          truncated: content.length > max,
          content: content.slice(0, max),
        };
      },
    }),
  };
}

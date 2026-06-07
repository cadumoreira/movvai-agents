import { LinearClient } from "@linear/sdk";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { config } from "../config.js";
import { audit } from "../audit/log.js";

/**
 * Ferramentas do Linear para o PM organizar a demanda.
 * O ticket é o "handoff tipado" do time — criar/refinar ticket é autônomo (Fase 0).
 */
export function linearTools(): ToolSet {
  const linear = new LinearClient({ apiKey: config.linear.apiKey });

  /** Resolve o teamId pelo LINEAR_TEAM_KEY, ou usa o primeiro time da conta. */
  async function resolveTeamId(): Promise<string> {
    const teams = await linear.teams();
    if (config.linear.teamKey) {
      const match = teams.nodes.find((t) => t.key === config.linear.teamKey);
      if (!match) throw new Error(`Time Linear "${config.linear.teamKey}" não encontrado.`);
      return match.id;
    }
    const first = teams.nodes[0];
    if (!first) throw new Error("Nenhum time encontrado na conta do Linear.");
    return first.id;
  }

  return {
    linear_create_issue: tool({
      description:
        "Cria um ticket (issue) no Linear com a demanda refinada. Use depois de investigar o problema. A descrição deve ter contexto, passos de reprodução (se bug) e critérios de aceite.",
      inputSchema: z.object({
        title: z.string().describe("Título curto e claro do ticket."),
        description: z
          .string()
          .describe(
            "Descrição em Markdown: contexto, passos de reprodução (se bug), comportamento esperado e critérios de aceite.",
          ),
        priority: z
          .number()
          .int()
          .min(0)
          .max(4)
          .optional()
          .describe("Prioridade Linear: 0=nenhuma, 1=urgente, 2=alta, 3=média, 4=baixa."),
      }),
      execute: async ({ title, description, priority }) => {
        const teamId = await resolveTeamId();
        const payload = await linear.createIssue({ teamId, title, description, priority });
        const issue = await payload.issue;
        if (!issue) return { ok: false, error: "Falha ao criar o ticket." };
        audit({ kind: "ticket_created", actor: "pm", detail: issue.identifier, meta: { url: issue.url, title } });
        return { ok: true, identifier: issue.identifier, url: issue.url, title };
      },
    }),

    linear_comment: tool({
      description: "Adiciona um comentário a um ticket existente (por identificador, ex.: LIN-123).",
      inputSchema: z.object({
        identifier: z.string().describe("Identificador do ticket, ex.: LIN-123."),
        body: z.string().describe("Comentário em Markdown."),
      }),
      execute: async ({ identifier, body }) => {
        const res = await linear.searchIssues(identifier, { first: 1 });
        const issue = res.nodes[0];
        if (!issue) return { ok: false, error: `Ticket ${identifier} não encontrado.` };
        await linear.createComment({ issueId: issue.id, body });
        return { ok: true, identifier };
      },
    }),

    linear_search_issues: tool({
      description: "Busca tickets existentes no Linear por texto, para evitar duplicar demanda.",
      inputSchema: z.object({
        query: z.string().describe("Texto a buscar no título/descrição."),
      }),
      execute: async ({ query }) => {
        const res = await linear.searchIssues(query, { first: 5 });
        return {
          results: res.nodes.map((i) => ({
            identifier: i.identifier,
            title: i.title,
            url: i.url,
          })),
        };
      },
    }),
  };
}

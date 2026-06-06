import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "../agents/context.js";
import { bus } from "../events/bus.js";

/**
 * Ferramenta do PM para passar uma demanda ao Dev. A delegação é visível: dispara
 * um evento que acorda o worker do Dev, que vai trabalhar na MESMA thread do Slack.
 */
export function delegateTools(ctx: AgentContext): ToolSet {
  return {
    delegate_to_dev: tool({
      description:
        "Passa uma demanda já refinada para o agente Dev implementar. Use depois de criar o ticket. O Dev vai trabalhar num sandbox e pedir aprovação antes de abrir o PR.",
      inputSchema: z.object({
        ticket_title: z.string().describe("Título do ticket/demanda."),
        ticket_url: z.string().optional().describe("URL do ticket no Linear, se houver."),
        ticket_identifier: z.string().optional().describe("Identificador (ex.: LIN-123)."),
        instructions: z
          .string()
          .describe(
            "Instruções claras do que o Dev deve implementar: o problema, o comportamento esperado e onde olhar (arquivos/áreas do repo).",
          ),
        repo: z.string().optional().describe('Repositório "owner/repo" (se diferente do padrão).'),
      }),
      execute: async ({ ticket_title, ticket_url, ticket_identifier, instructions, repo }) => {
        bus.emit("dev.task.requested", {
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          threadKey: ctx.threadKey,
          ticket: { title: ticket_title, url: ticket_url, identifier: ticket_identifier },
          instructions,
          repo,
        });
        return { ok: true, delegated_to: "dev", ticket: ticket_identifier ?? ticket_title };
      },
    }),
  };
}

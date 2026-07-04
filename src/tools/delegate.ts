import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "../agents/context.js";
import { queue } from "../queue/index.js";
import { track } from "../board/board.js";

const taskInput = z.object({
  ticket_title: z.string().describe("Título do ticket/demanda."),
  ticket_url: z.string().optional().describe("URL do ticket no Linear, se houver."),
  ticket_identifier: z.string().optional().describe("Identificador (ex.: LIN-123)."),
  instructions: z
    .string()
    .describe("Instruções claras do que deve ser feito: problema, comportamento esperado, onde olhar."),
  repo: z.string().optional().describe('Repositório "owner/repo" (se diferente do padrão).'),
});

/** Delegação para o Dev (implementar). Usada por PM e Tech Lead. */
export function delegateToDev(ctx: AgentContext): ToolSet {
  return {
    delegate_to_dev: tool({
      description:
        "Passa uma demanda já refinada para o Dev implementar. O Dev trabalha num sandbox e pede aprovação antes de abrir o PR.",
      inputSchema: taskInput,
      execute: async (t) => {
        track(
          `${ctx.threadKey}:dev`,
          { title: t.ticket_title, agent: "Téo (Dev)", squad: "produto", column: "fila" },
          "demanda delegada ao Dev",
        );
        await queue.enqueue("dev-task", {
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          threadKey: ctx.threadKey,
          ticket: { title: t.ticket_title, url: t.ticket_url, identifier: t.ticket_identifier },
          instructions: t.instructions,
          repo: t.repo,
        });
        return { ok: true, delegated_to: "dev", ticket: t.ticket_identifier ?? t.ticket_title };
      },
    }),
  };
}

/** Delegação para o Tech Lead (desenhar/arquitetar antes de implementar). Usada pelo PM. */
export function delegateToTechLead(ctx: AgentContext): ToolSet {
  return {
    delegate_to_techlead: tool({
      description:
        "Encaminha uma demanda complexa/arquitetural para o Tech Lead avaliar e desenhar a abordagem antes de ir para o Dev. Use quando houver decisão de design relevante.",
      inputSchema: taskInput,
      execute: async (t) => {
        track(
          `${ctx.threadKey}:techlead`,
          { title: t.ticket_title, agent: "Rui (Tech Lead)", squad: "produto", column: "fila" },
          "demanda encaminhada ao Tech Lead",
        );
        await queue.enqueue("techlead-task", {
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          threadKey: ctx.threadKey,
          ticket: { title: t.ticket_title, url: t.ticket_url, identifier: t.ticket_identifier },
          instructions: t.instructions,
          repo: t.repo,
        });
        return { ok: true, delegated_to: "techlead", ticket: t.ticket_identifier ?? t.ticket_title };
      },
    }),
  };
}

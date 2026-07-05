import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "../agents/context.js";
import { queue } from "../queue/index.js";
import { track } from "../board/board.js";
import { opsSpecialistName } from "../agents/ops-specialist.js";

/** Delegação PM → squad de Operações (vendas, atendimento, financeiro). */
export function delegateToOps(ctx: AgentContext): ToolSet {
  return {
    delegate_to_ops: tool({
      description:
        "Passa uma demanda de OPERAÇÕES para a pessoa certa: sdr (prospecção/cold e-mail — Igor), " +
        "suporte (responder cliente/ticket — Lia) ou financeiro (cobrança/follow-up — Otto). " +
        "Nada é enviado sem aprovação humana. Inclua TODO o contexto (destinatário, valores, o texto do cliente…).",
      inputSchema: z.object({
        discipline: z.enum(["sdr", "suporte", "financeiro"]).describe("Quem cuida da demanda."),
        title: z.string().describe("Título curto da demanda."),
        instructions: z
          .string()
          .describe("Contexto completo: quem, o quê, valores/prazos, e o texto original do cliente se houver."),
      }),
      execute: async ({ discipline, title, instructions }) => {
        track(
          `${ctx.threadKey}:ops-${discipline}`,
          { title, agent: opsSpecialistName(discipline), squad: "operacoes", column: "fila" },
          "demanda delegada às operações",
        );
        await queue.enqueue("ops-task", {
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          threadKey: ctx.threadKey,
          discipline,
          title,
          instructions,
        });
        return { ok: true, delegated_to: opsSpecialistName(discipline) };
      },
    }),
  };
}

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "../agents/context.js";
import { queue } from "../queue/index.js";
import type { OpsDiscipline } from "../queue/types.js";
import { track } from "../board/board.js";
import { opsSpecialistName } from "../agents/ops-specialist.js";

/**
 * Normaliza a disciplina de operações (aceita sinônimos comuns em PT/EN), no mesmo
 * padrão do marketing. Retorna null se não reconhecer — quem chama decide o erro.
 */
export function normalizeOpsDiscipline(input: string): OpsDiscipline | null {
  const s = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos ("prospecção" → "prospeccao")
    .trim();
  if (/(sdr|venda|prospec|lead|outbound|cold)/.test(s)) return "sdr";
  if (/(suporte|atendimento|ticket|cliente|support|help)/.test(s)) return "suporte";
  if (/(financeiro|cobranca|fatura|boleto|pagamento|billing|finance)/.test(s)) return "financeiro";
  return null;
}

/** Delegação PM → squad de Operações (vendas, atendimento, financeiro). */
export function delegateToOps(ctx: AgentContext): ToolSet {
  return {
    delegate_to_ops: tool({
      description:
        "Passa uma demanda de OPERAÇÕES para a pessoa certa: sdr (prospecção/cold e-mail — Igor), " +
        "suporte (responder cliente/ticket — Lia) ou financeiro (cobrança/follow-up — Otto). " +
        "Nada é enviado sem aprovação humana. Inclua TODO o contexto (destinatário, valores, o texto do cliente…).",
      inputSchema: z.object({
        discipline: z.string().describe('Quem cuida da demanda: "sdr", "suporte" ou "financeiro".'),
        title: z.string().describe("Título curto da demanda."),
        instructions: z
          .string()
          .describe("Contexto completo: quem, o quê, valores/prazos, e o texto original do cliente se houver."),
      }),
      execute: async (t) => {
        const discipline = normalizeOpsDiscipline(t.discipline);
        if (!discipline) {
          return { ok: false, error: `Disciplina "${t.discipline}" não reconhecida. Use: sdr, suporte ou financeiro.` };
        }
        track(
          `${ctx.threadKey}:ops-${discipline}`,
          { title: t.title, agent: opsSpecialistName(discipline), squad: "operacoes", column: "fila" },
          "demanda delegada às operações",
        );
        await queue.enqueue("ops-task", {
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          threadKey: ctx.threadKey,
          discipline,
          title: t.title,
          instructions: t.instructions,
        });
        return { ok: true, delegated_to: discipline, specialist: opsSpecialistName(discipline) };
      },
    }),
  };
}

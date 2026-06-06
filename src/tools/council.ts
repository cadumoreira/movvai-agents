import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { councilEnabled, deliberate } from "../council/council.js";

/**
 * Ferramenta de Conselho multi-modelo. O agente convoca quando a decisão é de alto valor
 * (veredito de QA, escolha de arquitetura) e quer um parecer colegiado de vários modelos.
 * Só fica disponível se houver ≥2 modelos configurados em COUNCIL_MODELS.
 */
export function councilTools(): ToolSet {
  if (!councilEnabled()) return {};

  return {
    deliberate: tool({
      description:
        "Convoca um conselho de vários modelos para decidir uma questão de alto valor (ex.: aprovar/recusar um PR, escolher uma abordagem de arquitetura). Use quando o custo de errar for alto e você quiser pareceres independentes sintetizados. Forneça a questão e o contexto (evidências: testes, diff, trechos de código).",
      inputSchema: z.object({
        question: z.string().describe("A decisão a tomar, de forma objetiva."),
        context: z.string().describe("Evidências relevantes: saída de testes, resumo do diff, código."),
      }),
      execute: async ({ question, context }) => {
        const result = await deliberate(question, context);
        return {
          recommendation: result.recommendation,
          pareceres: result.proposals.map((p) => ({ model: p.model, resumo: p.answer.slice(0, 600) })),
        };
      },
    }),
  };
}

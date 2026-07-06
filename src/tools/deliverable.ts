import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { track } from "../board/board.js";

/**
 * Registra o ENTREGÁVEL de um card. Toda subtarefa precisa anexar o que produziu — é o
 * que impede o board de "mentir" (concluído sem artefato). O worker lê o card depois: se
 * nada foi anexado, a subtarefa não entregou de verdade.
 */
export function deliverableTools(cardKey: string): ToolSet {
  return {
    attach_deliverable: tool({
      description:
        "Registra o ENTREGÁVEL da subtarefa (o artefato concreto que você produziu). " +
        "Chame ISTO quando terminar, com o link real quando houver. Sem entregável anexado, " +
        "a subtarefa não conta como entregue. Um por subtarefa.",
      inputSchema: z.object({
        kind: z.string().describe('Tipo: "pr", "notion", "url", "doc", "arquivo", "thread"…'),
        summary: z.string().describe("Uma linha: o que você entregou."),
        url: z.string().optional().describe("Link do artefato, quando existir."),
      }),
      execute: async ({ kind, summary, url }) => {
        track(cardKey, { deliverable: { kind, summary, url } }, `entregável anexado: ${summary}`);
        return { ok: true };
      },
    }),
  };
}

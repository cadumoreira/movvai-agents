import type { MarketingDiscipline, OpsDiscipline } from "../queue/types.js";

/**
 * Roteamento de follow-up na thread: mensagem começando com o nome de um agente vai
 * direto para ele ("Sofia, troca o tom do post 2"), em vez de sempre passar pela Ana.
 *
 * - Nomes do squad de marketing → job direto (Malu ou especialista).
 * - Nomes do time de produto (e nenhum nome) → fluxo normal da Ana, que tem a memória
 *   da thread e re-delega com contexto.
 */

export type RoutedTarget =
  | { kind: "lead" }
  | { kind: "specialist"; discipline: MarketingDiscipline }
  | { kind: "ops"; discipline: OpsDiscipline }
  | { kind: "pm" };

const NAME_MAP: Record<string, RoutedTarget> = {
  ana: { kind: "pm" },
  rui: { kind: "pm" },
  teo: { kind: "pm" },
  bia: { kind: "pm" },
  dani: { kind: "pm" },
  malu: { kind: "lead" },
  caio: { kind: "specialist", discipline: "conteudo" },
  sofia: { kind: "specialist", discipline: "social" },
  leo: { kind: "specialist", discipline: "ads" },
  nina: { kind: "specialist", discipline: "seo" },
  igor: { kind: "ops", discipline: "sdr" },
  lia: { kind: "ops", discipline: "suporte" },
  otto: { kind: "ops", discipline: "financeiro" },
};

/** "status" (sozinho ou no começo) = pedir o digest instantâneo do time. */
export function isStatusCommand(text: string): boolean {
  return /^@?status\b/i.test(text.trim());
}

/** Alvo quando a mensagem começa com o nome de um agente; null = sem endereçamento. */
export function resolveAgentMention(text: string): RoutedTarget | null {
  const first = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // "Téo" → "teo"
    .trim()
    .split(/\s+/)[0]
    ?.replace(/^@/, "")
    .replace(/[,:;!?.]+$/, "");
  if (!first) return null;
  return NAME_MAP[first] ?? null;
}

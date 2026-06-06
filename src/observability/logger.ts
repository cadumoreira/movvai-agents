import type { LanguageModelUsage } from "ai";

/**
 * Preço por 1M tokens (input/output), USD. Snapshot jun/2026 — re-validar.
 * Usado só para estimativa de custo nos logs (observabilidade leve).
 * Em produção: exportar spans via OpenLLMetry/OTel → Langfuse.
 */
const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "anthropic:claude-opus-4-8": { in: 5, out: 25 },
  "anthropic:claude-sonnet-4-6": { in: 3, out: 15 },
  "anthropic:claude-haiku-4-5": { in: 1, out: 5 },
  "openai:gpt-5": { in: 1.25, out: 10 },
  "google:gemini-3-pro": { in: 2, out: 12 },
  "google:gemini-3-flash": { in: 0.5, out: 3 },
};

export function logUsage(
  agentId: string,
  model: string,
  usage: LanguageModelUsage | undefined,
): void {
  const inTok = usage?.inputTokens ?? 0;
  const outTok = usage?.outputTokens ?? 0;
  const price = PRICE_PER_MTOK[model];
  const cost = price ? (inTok * price.in + outTok * price.out) / 1_000_000 : undefined;

  console.log(
    JSON.stringify({
      level: "info",
      kind: "agent_run",
      agent: agentId,
      model,
      tokens: { input: inTok, output: outTok },
      estimatedCostUSD: cost !== undefined ? Number(cost.toFixed(4)) : "n/d",
      at: new Date().toISOString(),
    }),
  );
}

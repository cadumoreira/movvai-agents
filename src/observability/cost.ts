import type { LanguageModelUsage } from "ai";

/**
 * Preço por 1M tokens (input/output), USD. Snapshot jun/2026 — re-validar.
 * Módulo neutro (sem dependências) usado por logger e billing.
 */
const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "anthropic:claude-opus-4-8": { in: 5, out: 25 },
  "anthropic:claude-sonnet-4-6": { in: 3, out: 15 },
  "anthropic:claude-haiku-4-5": { in: 1, out: 5 },
  "openai:gpt-5": { in: 1.25, out: 10 },
  "google:gemini-3-pro": { in: 2, out: 12 },
  "google:gemini-3-flash": { in: 0.5, out: 3 },
};

const CACHE_READ_FACTOR = 0.1; // leitura de cache custa ~10% do input normal

export interface UsageSummary {
  tokens: { input: number; cached: number; output: number };
  cacheHitRate: number;
  estimatedCostUSD: number | undefined;
}

/** Função pura: calcula custo estimado e cache-hit a partir do uso de tokens. */
export function summarizeUsage(model: string, usage: LanguageModelUsage | undefined): UsageSummary {
  const inTok = usage?.inputTokens ?? 0;
  const outTok = usage?.outputTokens ?? 0;
  const cachedTok = usage?.cachedInputTokens ?? 0;
  const uncachedIn = Math.max(inTok - cachedTok, 0);
  const cacheHitRate = inTok > 0 ? cachedTok / inTok : 0;

  const price = PRICE_PER_MTOK[model];
  const cost = price
    ? (uncachedIn * price.in + cachedTok * price.in * CACHE_READ_FACTOR + outTok * price.out) /
      1_000_000
    : undefined;

  return {
    tokens: { input: inTok, cached: cachedTok, output: outTok },
    cacheHitRate: Number(cacheHitRate.toFixed(2)),
    estimatedCostUSD: cost !== undefined ? Number(cost.toFixed(4)) : undefined,
  };
}

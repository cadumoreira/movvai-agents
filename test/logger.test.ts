import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeUsage } from "../src/observability/logger.js";

test("summarizeUsage calcula custo sem cache", () => {
  const s = summarizeUsage("anthropic:claude-opus-4-8", {
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
  });
  // 1M input * $5/1M = $5
  assert.equal(s.estimatedCostUSD, 5);
  assert.equal(s.cacheHitRate, 0);
});

test("summarizeUsage aplica desconto de cache na leitura", () => {
  const s = summarizeUsage("anthropic:claude-opus-4-8", {
    inputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
  });
  // tudo cacheado: 1M * $5 * 0.1 = $0.5
  assert.equal(s.estimatedCostUSD, 0.5);
  assert.equal(s.cacheHitRate, 1);
});

test("summarizeUsage retorna custo indefinido para modelo desconhecido", () => {
  const s = summarizeUsage("ollama:llama3.1", { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  assert.equal(s.estimatedCostUSD, undefined);
});

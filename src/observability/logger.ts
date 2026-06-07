import type { LanguageModelUsage } from "ai";
import { record } from "./activity.js";
import { summarizeUsage } from "./cost.js";
import { meterUsage } from "../billing/meter.js";

// Reexporta para manter imports/tests existentes.
export { summarizeUsage } from "./cost.js";
export type { UsageSummary } from "./cost.js";

export function logUsage(
  agentId: string,
  model: string,
  usage: LanguageModelUsage | undefined,
): void {
  const s = summarizeUsage(model, usage);
  record({
    time: new Date().toISOString(),
    kind: "agent_run",
    agent: agentId,
    model,
    cost: s.estimatedCostUSD,
    cacheHitRate: s.cacheHitRate,
  });
  meterUsage(agentId, model, usage); // billing por organização

  console.log(
    JSON.stringify({
      level: "info",
      kind: "agent_run",
      agent: agentId,
      model,
      tokens: s.tokens,
      cacheHitRate: s.cacheHitRate,
      estimatedCostUSD: s.estimatedCostUSD ?? "n/d",
      at: new Date().toISOString(),
    }),
  );
}

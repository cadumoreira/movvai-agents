import { appendFileSync } from "node:fs";
import type { LanguageModelUsage } from "ai";
import { config } from "../config.js";
import { summarizeUsage } from "../observability/cost.js";

/**
 * Medição de consumo (billing) por organização. Persiste cada execução em JSONL durável
 * (BILLING_LOG_PATH) e mantém totais agregados por org em memória para o painel.
 * É a base para cobrança por consumo (espelhando o mercado de agentes).
 */
export interface MeterEntry {
  time: string;
  org: string;
  agent: string;
  model: string;
  input: number;
  cached: number;
  output: number;
  costUSD: number;
}

export interface OrgTotal {
  org: string;
  runs: number;
  input: number;
  output: number;
  costUSD: number;
}

const MAX = 1000;
const ring: MeterEntry[] = [];
const totals = new Map<string, OrgTotal>();

export function record(entry: MeterEntry): void {
  ring.push(entry);
  if (ring.length > MAX) ring.shift();

  const t = totals.get(entry.org) ?? { org: entry.org, runs: 0, input: 0, output: 0, costUSD: 0 };
  t.runs += 1;
  t.input += entry.input;
  t.output += entry.output;
  t.costUSD += entry.costUSD;
  totals.set(entry.org, t);

  try {
    appendFileSync(config.billing.path, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("Falha ao escrever no log de billing:", err);
  }
}

/** Mede uma execução a partir do uso de tokens (calcula custo e registra). */
export function meterUsage(agent: string, model: string, usage: LanguageModelUsage | undefined): void {
  const s = summarizeUsage(model, usage);
  record({
    time: new Date().toISOString(),
    org: config.security.orgId,
    agent,
    model,
    input: s.tokens.input,
    cached: s.tokens.cached,
    output: s.tokens.output,
    costUSD: s.estimatedCostUSD ?? 0,
  });
}

export function billingSummary(): OrgTotal[] {
  return [...totals.values()].map((t) => ({ ...t, costUSD: Number(t.costUSD.toFixed(4)) }));
}

export function listMeter(limit = 100): MeterEntry[] {
  return ring.slice(-limit).reverse();
}

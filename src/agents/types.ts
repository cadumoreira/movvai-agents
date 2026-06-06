import type { ToolSet } from "ai";

/**
 * Uma persona persistente do time. Cada papel (PM, Dev, QA...) é a mesma "forma",
 * parametrizada por identidade, modelo, ferramentas e política de autonomia.
 */
export interface Agent {
  /** Identificador interno (ex.: "pm"). */
  id: string;
  /** Nome de exibição (como o time o chama). */
  name: string;
  /** System prompt — define a persona e o comportamento. */
  system: string;
  /** Modelo no formato "provedor:modelo" (resolvido pelo gateway). */
  model: string;
  /** Ferramentas disponíveis para este agente (via MCP/SDKs). */
  tools: ToolSet;
  /** Limite de passos do loop de tool-calling (controle de custo). */
  maxSteps: number;
}

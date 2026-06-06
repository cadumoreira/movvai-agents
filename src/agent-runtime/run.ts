import {
  generateText,
  stepCountIs,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
} from "ai";
import type { Agent } from "../agents/types.js";
import { resolveModel } from "../models/gateway.js";
import { logUsage } from "../observability/logger.js";

/** Para o loop quando o total de tokens consumidos atinge o orçamento. */
function tokenBudgetReached(budget: number): StopCondition<ToolSet> {
  return ({ steps }) => {
    if (!budget) return false;
    let total = 0;
    for (const s of steps) {
      total += (s.usage?.inputTokens ?? 0) + (s.usage?.outputTokens ?? 0);
    }
    return total >= budget;
  };
}

/**
 * Roda um agente sobre o histórico da conversa.
 *
 * A AI SDK conduz o loop de tool-calling automaticamente, parando em `maxSteps` OU
 * ao atingir o orçamento de tokens (guarda de custo). Devolve o texto final + as
 * mensagens geradas (para anexar à memória da thread).
 */
export async function runAgent(
  agent: Agent,
  history: ModelMessage[],
): Promise<{ text: string; newMessages: ModelMessage[] }> {
  // Prompt caching: marca o system prompt como cacheável. No Anthropic isso cacheia
  // tools+system (prefixo reusado a cada turn → até ~90% mais barato na leitura). Outros
  // provedores ignoram o providerOptions.anthropic (OpenAI cacheia sozinho).
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: agent.system,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    ...history,
  ];

  const result = await generateText({
    model: resolveModel(agent.model),
    messages,
    tools: agent.tools,
    stopWhen: [stepCountIs(agent.maxSteps), tokenBudgetReached(agent.tokenBudget ?? 0)],
  });

  logUsage(agent.id, agent.model, result.totalUsage ?? result.usage);

  return { text: result.text, newMessages: result.response.messages };
}

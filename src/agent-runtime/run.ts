import { generateText, stepCountIs, type ModelMessage } from "ai";
import type { Agent } from "../agents/types.js";
import { resolveModel } from "../models/gateway.js";
import { logUsage } from "../observability/logger.js";

/**
 * Roda um agente sobre o histórico da conversa.
 *
 * A AI SDK conduz o loop de tool-calling automaticamente (o agente investiga via
 * ferramentas e responde), parando em `maxSteps` para conter custo. Devolve o texto
 * final + as mensagens geradas (para anexar à memória da thread).
 */
export async function runAgent(
  agent: Agent,
  history: ModelMessage[],
): Promise<{ text: string; newMessages: ModelMessage[] }> {
  const result = await generateText({
    model: resolveModel(agent.model),
    system: agent.system,
    messages: history,
    tools: agent.tools,
    stopWhen: stepCountIs(agent.maxSteps),
  });

  logUsage(agent.id, agent.model, result.totalUsage ?? result.usage);

  // result.response.messages traz toda a sequência (tool calls/results + texto final).
  return { text: result.text, newMessages: result.response.messages };
}

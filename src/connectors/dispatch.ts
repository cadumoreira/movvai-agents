import type { ModelMessage } from "ai";
import type { Agent } from "../agents/types.js";
import type { AgentContext } from "../agents/context.js";
import type { Messenger } from "../messaging/messenger.js";
import type { ThreadMemory } from "../memory/thread-memory.js";
import { runAgent } from "../agent-runtime/run.js";
import { answerQuestion } from "../approvals/questions.js";
import { track, listBoard } from "../board/board.js";
import { resolveAgentMention, isStatusCommand } from "./routing.js";
import { specialistName } from "../agents/marketing-specialist.js";
import { opsSpecialistName } from "../agents/ops-specialist.js";
import { collectDigest, formatDigest } from "../digest/digest.js";
import { appendMessage } from "../messaging/conversations.js";
import { queue } from "../queue/index.js";

export interface ThreadRef {
  channel: string;
  threadTs: string;
  threadKey: string;
}

export interface DispatchDeps {
  messenger: Messenger;
  agentFactory: (ctx: AgentContext, userText: string) => Agent;
  memory: ThreadMemory;
  /** Quem mandou (para answerQuestion e auditoria): "slack:U123" ou "painel". */
  actor: string;
  /** Rótulo do humano na conversa exibida. */
  humanLabel?: string;
}

export type DispatchResult = "answered" | "status" | "routed" | "pm" | "empty";

/**
 * Pipeline de menção, INDEPENDENTE de superfície: é o mesmo código para uma menção no
 * Slack e para uma mensagem no chat do painel. Decide o que fazer com o texto do humano:
 *   1) é resposta a uma pergunta pendente? → responde a pergunta;
 *   2) é "status"? → digest determinístico;
 *   3) começa com nome de agente? → vai direto pra pessoa certa (com contexto da thread);
 *   4) senão → Ana (PM), com memória da thread.
 */
export async function dispatchMention(userText: string, thread: ThreadRef, deps: DispatchDeps): Promise<DispatchResult> {
  const { channel, threadTs, threadKey } = thread;
  const text = userText.trim();
  if (!text) return "empty";

  // Registra a fala do humano na thread interna (o painel exibe a conversa).
  appendMessage(threadKey, deps.humanLabel ?? "você", text, true);

  // 1) Resposta a uma pergunta que um agente deixou nesta thread.
  if (answerQuestion(threadKey, text, deps.actor)) return "answered";

  // 2) "status" → digest instantâneo (zero tokens).
  if (isStatusCommand(text)) {
    await deps.messenger.post({ channel, threadTs }, formatDigest(collectDigest()), "sistema");
    return "status";
  }

  // 3) Endereçada a alguém dos squads ("Sofia, troca o tom..." / "Lia, responde...").
  const routed = resolveAgentMention(text);
  if (routed && routed.kind !== "pm") {
    const suffix =
      routed.kind === "lead" ? "marketing-lead" : routed.kind === "ops" ? `ops-${routed.discipline}` : `mkt-${routed.discipline}`;
    const cardKey = `${threadKey}:${suffix}`;
    const existing = listBoard().find((c) => c.key === cardKey);
    const title = existing?.title ?? text.slice(0, 80);
    const instructions = existing
      ? `Ajuste solicitado na thread sobre o trabalho anterior ("${existing.title}"). ` +
        `Procure o material existente no Notion antes de refazer do zero.\n\nPedido: ${text}`
      : text;

    await deps.memory.append(threadKey, { role: "user", content: text });
    if (routed.kind === "lead") {
      track(cardKey, { title, agent: "Malu (Head de Marketing)", squad: "marketing", column: "fila" }, "follow-up na thread");
      await queue.enqueue("marketing-task", { channel, threadTs, threadKey, brief: { title }, instructions });
    } else if (routed.kind === "ops") {
      track(cardKey, { title, agent: opsSpecialistName(routed.discipline), squad: "operacoes", column: "fila" }, "follow-up na thread");
      await queue.enqueue("ops-task", { channel, threadTs, threadKey, discipline: routed.discipline, title, instructions });
    } else {
      track(cardKey, { title, agent: specialistName(routed.discipline), squad: "marketing", column: "fila" }, "follow-up na thread");
      await queue.enqueue("marketing-work", { channel, threadTs, threadKey, discipline: routed.discipline, brief: { title }, instructions });
    }
    return "routed";
  }

  // 4) Fluxo normal: Ana (PM), com a memória da thread.
  //    NÃO cria card aqui — conversar não é uma "frente" no board. O board só ganha
  //    card quando há TRABALHO delegado: se a Ana delegar, as ferramentas de delegação
  //    e os workers criam os cards das frentes (dev/techlead/marketing/ops). Assim,
  //    bate-papo e respostas não viram cards que piscam direto para "Concluído".
  try {
    const agent = deps.agentFactory({ channel, threadTs, threadKey, messenger: deps.messenger }, text);
    await deps.memory.append(threadKey, { role: "user", content: text });
    const { text: reply, newMessages } = await runAgent(agent, await deps.memory.get(threadKey));
    await deps.memory.append(threadKey, ...(newMessages as ModelMessage[]));
    await deps.messenger.post({ channel, threadTs }, reply || "(sem resposta)", agent.name);
  } catch (err) {
    console.error("Erro ao processar mensagem:", err);
    await deps.messenger.post(
      { channel, threadTs },
      `Ops, tive um problema ao processar isso: ${err instanceof Error ? err.message : String(err)}`,
      "sistema",
    );
  }
  return "pm";
}

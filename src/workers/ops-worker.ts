import type { ModelMessage } from "ai";
import { queue } from "../queue/index.js";
import type { JobMap } from "../queue/types.js";
import { runAgent } from "../agent-runtime/run.js";
import { createOpsSpecialistAgent, opsSpecialistName } from "../agents/ops-specialist.js";
import { type Approver } from "../approvals/gate.js";
import type { Messenger } from "../messaging/messenger.js";
import { routeModel } from "../models/router.js";
import { config } from "../config.js";
import { track, type Deliverable } from "../board/board.js";
import { formatPreflight } from "../deps/preflight.js";
import { preflightOrAbort } from "./support.js";
import { askQuestion } from "../approvals/questions.js";
import { threadContextBlock } from "../messaging/conversations.js";

/**
 * Ferramentas cuja presença no turno significa que a demanda ANDOU de verdade:
 * pediu aprovação de envio (`request_send_approval`, que já trata a espera do humano)
 * ou pausou pedindo esclarecimento (`ask_clarification`, idem). Um turno que termina
 * numa pergunta SEM nenhuma delas ainda não concluiu nada.
 */
const COMPLETION_TOOLS = ["request_send_approval", "ask_clarification"];

/** Teto de idas-e-vindas antes de encerrar — trava contra loop caso o modelo nunca
 *  parta para a ação. */
const MAX_INTERVIEW_ROUNDS = 5;

/** Nomes das ferramentas efetivamente chamadas nas mensagens de um turno. */
export function toolNamesUsed(messages: ModelMessage[]): Set<string> {
  const names = new Set<string>();
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: string }).type === "tool-call") {
        const name = (part as { toolName?: string }).toolName;
        if (name) names.add(name);
      }
    }
  }
  return names;
}

/**
 * O turno terminou pedindo algo ao humano (texto com "?") SEM ter pedido aprovação de
 * envio ou pausado com `ask_clarification`? Então a demanda NÃO acabou: o modelo narrou
 * a pergunta em vez de usar a ferramenta de pausa, e o worker precisa segurar a espera
 * — senão a resposta do humano vaza para a PM (thread órfã). Determinístico e testável.
 */
export function endedNeedingHuman(text: string, messages: ModelMessage[]): boolean {
  const used = toolNamesUsed(messages);
  const acted = COMPLETION_TOOLS.some((t) => used.has(t));
  return !acted && /\?/.test(text ?? "");
}

export interface OpsDeps {
  /** Injetável para teste; por padrão o runtime real. */
  run?: typeof runAgent;
  createAgent?: typeof createOpsSpecialistAgent;
}

/**
 * Processa UM job "ops-task": instancia a persona da disciplina (Igor/Lia/Otto) e
 * trabalha na thread — com portão de aprovação antes de qualquer envio. Exportado
 * (separado da fiação do queue) para ser testável direto, sem depender do agendamento
 * assíncrono da fila.
 *
 * Enquanto o especialista só pergunta (em texto) sem pedir aprovação nem pausar com
 * `ask_clarification`, mantém a demanda em "Aguardando humano" e retoma quando a resposta
 * chega na thread — a mesma pausa durável do `ask_clarification`, mas garantida mesmo que
 * o modelo esqueça de chamar a ferramenta.
 */
export async function runOpsTask(
  task: JobMap["ops-task"],
  messenger: Messenger,
  deps: OpsDeps = {},
): Promise<void> {
  const run = deps.run ?? runAgent;
  const createAgent = deps.createAgent ?? createOpsSpecialistAgent;
  const post = (text: string) => messenger.post({ channel: task.channel, threadTs: task.threadTs }, text, opsSpecialistName(task.discipline));

  const cardKey = `${task.threadKey}:ops-${task.discipline}`;
  const checks = await preflightOrAbort(
    task.discipline,
    { cardKey, title: task.title, agent: opsSpecialistName(task.discipline), squad: "operacoes" },
    post,
  );
  if (!checks) return;
  try {
    track(
      cardKey,
      { title: task.title, agent: opsSpecialistName(task.discipline), squad: "operacoes", column: "execucao" },
      "trabalhando na demanda",
    );
    await post(`:briefcase: ${opsSpecialistName(task.discipline)} aqui — peguei *${task.title}*.`);

    const model = routeModel(config.models.ops, { text: task.instructions });
    const baseApprove = messenger.approver({ channel: task.channel, threadTs: task.threadTs, threadKey: task.threadKey });
    const approve: Approver = async (opts) => {
      track(cardKey, { column: "aprovacao" }, "pediu OK humano para enviar");
      const decision = await baseApprove(opts);
      track(cardKey, { column: "execucao" }, decision.approved ? "envio aprovado" : "envio recusado");
      return decision;
    };
    const specialist = createAgent(
      task.discipline,
      { approve, thread: { channel: task.channel, threadTs: task.threadTs, threadKey: task.threadKey, messenger } },
      model,
    );

    const initial =
      `Trabalhe na demanda a seguir.\n\nDemanda: ${task.title}\n\n${task.instructions}\n\n` +
      `Lembre: request_send_approval ANTES de qualquer envio.` +
      formatPreflight(checks) +
      threadContextBlock(task.threadKey);

    let history: ModelMessage[] = [{ role: "user", content: initial }];
    const usedAll = new Set<string>();
    let unresolved = false;

    for (let round = 0; ; round++) {
      const { text, newMessages } = await run(specialist, history);
      for (const name of toolNamesUsed(newMessages)) usedAll.add(name);
      if (text) await post(text);
      history = [...history, ...newMessages];

      // O especialista pediu algo sem ter agido: segura a demanda e espera a resposta na thread.
      const needs = endedNeedingHuman(text, newMessages);
      if (needs && round < MAX_INTERVIEW_ROUNDS) {
        track(cardKey, { column: "aprovacao" }, "aguardando suas respostas");
        const answer = await askQuestion(task.threadKey, text, opsSpecialistName(task.discipline));
        track(cardKey, { column: "execucao" }, "resposta recebida — continuando");
        history.push({ role: "user", content: answer });
        continue;
      }
      // Quebrou ainda precisando do humano (estourou o teto) → não concluiu de verdade.
      unresolved = needs;
      break;
    }

    // Entrega honesta: se encerrou ainda perguntando, é FALHA — não finge "concluído".
    if (unresolved) {
      track(
        cardKey,
        { column: "concluido", outcome: "falha" },
        `encerrou ainda perguntando após ${MAX_INTERVIEW_ROUNDS} rodadas — sem entrega`,
      );
    } else {
      const deliverable: Deliverable = usedAll.has("request_send_approval")
        ? { kind: "envio", summary: "envio aprovado pelo humano" }
        : { kind: "thread", summary: "concluída na thread (sem envio)" };
      track(cardKey, { column: "concluido", outcome: "ok", deliverable }, `entregável: ${deliverable.summary}`);
    }
  } catch (err) {
    track(cardKey, { column: "concluido", outcome: "falha" }, "erro na demanda");
    console.error("Erro no worker de operações:", err);
    await post(`Tive um problema na demanda: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Worker do squad de Operações: consome "ops-task" e delega ao processador acima.
 */
export function startOpsWorker(messenger: Messenger, deps: OpsDeps = {}): void {
  queue.process("ops-task", (task) => runOpsTask(task, messenger, deps));
}

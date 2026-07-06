import type { ModelMessage } from "ai";
import type { Messenger } from "../messaging/messenger.js";
import { queue } from "../queue/index.js";
import type { JobMap } from "../queue/types.js";
import { runAgent } from "../agent-runtime/run.js";
import { createMarketingSpecialistAgent, specialistName } from "../agents/marketing-specialist.js";
import { type Approver } from "../approvals/gate.js";
import { routeModel } from "../models/router.js";
import { config } from "../config.js";
import { track, listBoard, type Deliverable } from "../board/board.js";
import { formatPreflight } from "../deps/preflight.js";
import { preflightOrAbort } from "./support.js";
import { askQuestion } from "../approvals/questions.js";
import { threadContextBlock } from "../messaging/conversations.js";

/**
 * Ferramentas cuja presença no turno significa que a frente ANDOU de verdade: registrou
 * o entregável (`notion_create_page`), pediu aprovação de publicação (`request_publish_approval`)
 * ou pausou pedindo esclarecimento (`ask_clarification`). Um turno que termina numa pergunta
 * SEM nenhuma delas ainda não entregou nada.
 */
const COMPLETION_TOOLS = ["notion_create_page", "request_publish_approval", "ask_clarification"];

/** Teto de idas-e-vindas antes de encerrar — trava contra loop. */
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
 * O turno terminou pedindo algo ao humano (texto com "?") SEM ter produzido/pausado?
 * Então a frente NÃO acabou — o worker segura a espera (senão a resposta vaza para a PM).
 */
export function endedNeedingHuman(text: string, messages: ModelMessage[]): boolean {
  const used = toolNamesUsed(messages);
  const acted = COMPLETION_TOOLS.some((t) => used.has(t));
  return !acted && /\?/.test(text ?? "");
}

export interface MarketingWorkDeps {
  run?: typeof runAgent;
  createAgent?: typeof createMarketingSpecialistAgent;
}

/**
 * Processa UM job "marketing-work": instancia a persona da disciplina (Caio/Sofia/Leo/Nina),
 * produz o entregável e pede aprovação antes de publicar. Exportado (separado da fila) para
 * ser testável direto. Recebe o contexto da thread (memória compartilhada) e, enquanto só
 * perguntar sem agir, segura a frente em "Aguardando humano" e retoma com a resposta.
 */
export async function runMarketingWork(
  task: JobMap["marketing-work"],
  messenger: Messenger,
  deps: MarketingWorkDeps = {},
): Promise<void> {
  const run = deps.run ?? runAgent;
  const createAgent = deps.createAgent ?? createMarketingSpecialistAgent;
  const post = (text: string) => messenger.post({ channel: task.channel, threadTs: task.threadTs }, text, specialistName(task.discipline));

  const cardKey = `${task.threadKey}:mkt-${task.discipline}`;
  const checks = await preflightOrAbort(
    task.discipline,
    { cardKey, title: task.brief.title, agent: specialistName(task.discipline), squad: "marketing" },
    post,
  );
  if (!checks) return;
  try {
    track(
      cardKey,
      { title: task.brief.title, agent: specialistName(task.discipline), squad: "marketing", column: "execucao" },
      "produzindo o entregável",
    );
    await post(
      `:art: ${specialistName(task.discipline)} aqui — peguei a frente de *${task.brief.title}*. Produzindo o entregável…`,
    );
    const model = routeModel(config.models.marketing, { text: task.instructions });
    const baseApprove = messenger.approver({ channel: task.channel, threadTs: task.threadTs, threadKey: task.threadKey });
    const approve: Approver = async (opts) => {
      track(cardKey, { column: "aprovacao" }, "pediu OK humano para publicar");
      const decision = await baseApprove(opts);
      track(cardKey, { column: "execucao" }, decision.approved ? "publicação aprovada" : "publicação recusada");
      return decision;
    };
    const specialist = createAgent(
      task.discipline,
      { approve, thread: { channel: task.channel, threadTs: task.threadTs, threadKey: task.threadKey, messenger } },
      model,
    );

    const briefRef = [
      task.brief.url ? `Brief no Notion: ${task.brief.url}` : "",
      task.brief.pageId ? `page_id do brief (use como parent_page_id do entregável): ${task.brief.pageId}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const initial =
      `Produza o entregável da sua frente para o brief "${task.brief.title}".` +
      `${briefRef ? `\n${briefRef}` : ""}\n\n${task.instructions}\n\n` +
      `Registre o entregável no Notion e chame request_publish_approval antes de dá-lo como aprovado.` +
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

      const needs = endedNeedingHuman(text, newMessages);
      if (needs && round < MAX_INTERVIEW_ROUNDS) {
        track(cardKey, { column: "aprovacao" }, "aguardando suas respostas");
        const answer = await askQuestion(task.threadKey, text, specialistName(task.discipline));
        track(cardKey, { column: "execucao" }, "resposta recebida — continuando");
        history.push({ role: "user", content: answer });
        continue;
      }
      // Quebrou ainda precisando do humano (estourou o teto de rodadas) → não entregou.
      unresolved = needs;
      break;
    }

    // Entrega honesta: só fecha ok com um artefato REAL — Notion, aprovação de publicação, ou
    // um documento anexado (create_document). Texto solto na thread não conta como entrega.
    const card = listBoard().find((c) => c.key === cardKey);
    const produziu = usedAll.has("notion_create_page") || usedAll.has("request_publish_approval") || Boolean(card?.deliverable);
    if (unresolved) {
      track(
        cardKey,
        { column: "concluido", outcome: "falha" },
        `encerrou ainda perguntando após ${MAX_INTERVIEW_ROUNDS} rodadas — sem entrega`,
      );
    } else if (!produziu) {
      track(cardKey, { column: "concluido", outcome: "falha" }, "não produziu entregável — nada anexado (texto na thread não conta)");
    } else if (card?.deliverable) {
      // Documento anexado via create_document já setou o deliverable — mantém.
      track(cardKey, { column: "concluido", outcome: "ok" }, `entregável: ${card.deliverable.summary}`);
    } else {
      const deliverable: Deliverable = usedAll.has("notion_create_page")
        ? { kind: "notion", summary: "entregável registrado no Notion" }
        : { kind: "aprovacao", summary: "conteúdo aprovado para publicação" };
      track(cardKey, { column: "concluido", outcome: "ok", deliverable }, `entregável: ${deliverable.summary}`);
    }
  } catch (err) {
    track(cardKey, { column: "concluido", outcome: "falha" }, "erro ao produzir o entregável");
    console.error("Erro no worker de marketing:", err);
    await post(
      `Tive um problema ao produzir o entregável: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Worker das especialistas de marketing: consome "marketing-work" e delega ao processador acima.
 */
export function startMarketingWorker(messenger: Messenger, deps: MarketingWorkDeps = {}): void {
  queue.process("marketing-work", (task) => runMarketingWork(task, messenger, deps));
}

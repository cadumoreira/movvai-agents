import type { ModelMessage } from "ai";
import type { Messenger } from "../messaging/messenger.js";
import { queue } from "../queue/index.js";
import type { JobMap } from "../queue/types.js";
import { runAgent } from "../agent-runtime/run.js";
import { createMarketingLeadAgent } from "../agents/marketing-lead.js";
import { routeModel } from "../models/router.js";
import { config } from "../config.js";
import { track, type Deliverable } from "../board/board.js";
import { formatPreflight } from "../deps/preflight.js";
import { preflightOrAbort } from "./support.js";
import { askQuestion } from "../approvals/questions.js";
import { threadContextBlock } from "../messaging/conversations.js";

/**
 * Ferramentas cuja presença no turno significa que a frente ANDOU de verdade:
 * delegou (`assign_marketing_work`), gravou um documento da marca (`write_brand_doc`)
 * ou pausou pedindo esclarecimento (`ask_clarification`, que já trata a espera). Um
 * turno que termina numa pergunta SEM nenhuma delas ainda não concluiu nada.
 */
const COMPLETION_TOOLS = ["assign_marketing_work", "write_brand_doc", "ask_clarification"];

/** Teto de idas-e-vindas da entrevista antes de encerrar — trava contra loop caso o
 *  modelo nunca parta para a ação. */
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
 * O turno terminou pedindo algo ao humano (texto com "?") SEM ter delegado, gravado
 * doc ou pausado com `ask_clarification`? Então a frente NÃO acabou: o modelo narrou
 * a pergunta em vez de usar a ferramenta de pausa, e o worker precisa segurar a espera
 * — senão a resposta do humano vaza para a PM (thread órfã). Determinístico e testável.
 */
export function endedNeedingHuman(text: string, messages: ModelMessage[]): boolean {
  const used = toolNamesUsed(messages);
  const acted = COMPLETION_TOOLS.some((t) => used.has(t));
  return !acted && /\?/.test(text ?? "");
}

export interface MarketingLeadDeps {
  /** Injetável para teste; por padrão o runtime real. */
  run?: typeof runAgent;
  createAgent?: typeof createMarketingLeadAgent;
}

/**
 * Processa UM job "marketing-task": cria o brief no Notion e delega as frentes às
 * especialistas — tudo na mesma thread. Exportado (separado da fiação do queue) para
 * ser testável direto, sem depender do agendamento assíncrono da fila.
 *
 * A entrevista (criação de marca) acontece DENTRO deste job: enquanto a Malu só pergunta
 * sem delegar/gravar, mantém a frente em "Aguardando humano" e retoma quando a resposta
 * chega na thread — a mesma pausa durável do `ask_clarification`, mas garantida mesmo que
 * o modelo esqueça de chamar a ferramenta.
 */
export async function runMarketingLeadTask(
  task: JobMap["marketing-task"],
  messenger: Messenger,
  deps: MarketingLeadDeps = {},
): Promise<void> {
  const run = deps.run ?? runAgent;
  const createAgent = deps.createAgent ?? createMarketingLeadAgent;
  const post = (text: string) => messenger.post({ channel: task.channel, threadTs: task.threadTs }, text, "Malu (Head de Marketing)");

  const cardKey = `${task.threadKey}:marketing-lead`;
  const checks = await preflightOrAbort(
    "marketing-lead",
    { cardKey, title: task.brief.title, agent: "Malu (Head de Marketing)", squad: "marketing" },
    post,
  );
  if (!checks) return;
  try {
    track(
      cardKey,
      { title: task.brief.title, agent: "Malu (Head de Marketing)", squad: "marketing", column: "execucao" },
      "montando o brief no Notion",
    );
    await post(
      `:dart: Malu (Head de Marketing) aqui — vou montar o brief de *${task.brief.title}* no Notion e acionar o squad.`,
    );
    const model = routeModel(config.models.marketing, { text: task.instructions });
    const lead = createAgent(
      { channel: task.channel, threadTs: task.threadTs, threadKey: task.threadKey, messenger },
      task.brief,
      model,
    );

    const initial =
      `Planeje a demanda de marketing a seguir: crie o brief no Notion e delegue as frentes ` +
      `necessárias com assign_marketing_work (uma chamada por frente, com o page_id do brief).\n\n` +
      `Demanda: ${task.brief.title}\n\n${task.instructions}` +
      formatPreflight(checks) +
      threadContextBlock(task.threadKey);

    let history: ModelMessage[] = [{ role: "user", content: initial }];
    const usedAll = new Set<string>();
    let unresolved = false;

    for (let round = 0; ; round++) {
      const { text, newMessages } = await run(lead, history);
      for (const name of toolNamesUsed(newMessages)) usedAll.add(name);
      if (text) await post(text);
      history = [...history, ...newMessages];

      // A Malu pediu algo sem ter agido: segura a frente e espera a resposta na thread.
      const needs = endedNeedingHuman(text, newMessages);
      if (needs && round < MAX_INTERVIEW_ROUNDS) {
        track(cardKey, { column: "aprovacao" }, "aguardando suas respostas");
        const answer = await askQuestion(task.threadKey, text, "Malu (Head de Marketing)");
        track(cardKey, { column: "execucao" }, "resposta recebida — continuando");
        history.push({ role: "user", content: answer });
        continue;
      }
      // Quebrou ainda precisando do humano (estourou o teto) → não entregou.
      unresolved = needs;
      break;
    }

    const delegou = usedAll.has("assign_marketing_work") || usedAll.has("write_brand_doc");
    if (unresolved) {
      track(
        cardKey,
        { column: "concluido", outcome: "falha" },
        `encerrou ainda perguntando após ${MAX_INTERVIEW_ROUNDS} rodadas — sem entrega`,
      );
    } else if (!delegou) {
      // Honestidade: a Malu SÓ entrega delegando (assign_marketing_work) ou gravando doc de
      // marca. Se ela só "narrou" que acionou frentes no texto, nada foi feito → FALHA, não ok.
      track(
        cardKey,
        { column: "concluido", outcome: "falha" },
        "não delegou nem gravou nada — demanda não entregue (texto não conta como delegação)",
      );
    } else {
      const deliverable: Deliverable = usedAll.has("write_brand_doc")
        ? { kind: "doc", summary: "documentos de marca gravados" }
        : { kind: "arvore", summary: "brief pronto e frentes acionadas" };
      track(cardKey, { column: "concluido", outcome: "ok", deliverable }, `entregável: ${deliverable.summary}`);
    }
  } catch (err) {
    track(cardKey, { column: "concluido", outcome: "falha" }, "erro ao planejar o brief");
    console.error("Erro no worker da Head de Marketing:", err);
    await post(
      `Tive um problema ao planejar a demanda: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Worker da Head de Marketing: consome "marketing-task" e delega ao processador acima.
 */
export function startMarketingLeadWorker(messenger: Messenger, deps: MarketingLeadDeps = {}): void {
  queue.process("marketing-task", (task) => runMarketingLeadTask(task, messenger, deps));
}

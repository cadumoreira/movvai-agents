import type { ModelMessage } from "ai";
import type { Messenger } from "../messaging/messenger.js";
import { queue } from "../queue/index.js";
import type { JobMap } from "../queue/types.js";
import { runAgent } from "../agent-runtime/run.js";
import { createExecutorAgent } from "../agents/executor.js";
import { routeModel } from "../models/router.js";
import { config } from "../config.js";
import { track, listBoard } from "../board/board.js";
import { askQuestion } from "../approvals/questions.js";
import { threadContextBlock } from "../messaging/conversations.js";

/** Ferramentas que significam "a folha andou": anexou entregável ou pausou pedindo dado. */
const COMPLETION_TOOLS = ["attach_deliverable", "ask_clarification"];
const MAX_INTERVIEW_ROUNDS = 5;

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

/** Turno terminou pedindo algo ao humano sem ter anexado/pausado? Segura a folha. */
export function endedNeedingHuman(text: string, messages: ModelMessage[]): boolean {
  const used = toolNamesUsed(messages);
  const acted = COMPLETION_TOOLS.some((t) => used.has(t));
  return !acted && /\?/.test(text ?? "");
}

export interface SubtaskDeps {
  run?: typeof runAgent;
  createAgent?: typeof createExecutorAgent;
}

/**
 * Executa UMA folha da decomposição: instancia o executor, roda a subtarefa e fecha o
 * card de forma HONESTA — `ok` só se um entregável foi anexado (`attach_deliverable`);
 * senão `falha` com nota clara. O rollup do board fecha o pai quando todas as folhas
 * entregarem. Enquanto o executor só pergunta, a folha fica em "Aguardando humano".
 */
export async function runSubtask(
  job: JobMap["subtask"],
  messenger: Messenger,
  deps: SubtaskDeps = {},
): Promise<void> {
  const run = deps.run ?? runAgent;
  const createAgent = deps.createAgent ?? createExecutorAgent;
  const agentName = job.agentName ?? "Téo (Dev)";
  const post = (text: string) => messenger.post({ channel: job.channel, threadTs: job.threadTs }, text, agentName);
  const { cardKey, parentKey } = job;

  try {
    track(
      cardKey,
      { title: job.title, agent: agentName, squad: job.squad ?? "produto", column: "execucao", parentKey },
      "executando a subtarefa",
    );
    await post(`:hammer_and_wrench: ${agentName}: peguei *${job.title}*.`);

    const model = routeModel(config.models.dev, { text: job.instructions });
    const agent = createAgent(
      { channel: job.channel, threadTs: job.threadTs, threadKey: job.threadKey, messenger },
      { title: job.title, deliverableGoal: job.deliverableGoal, cardKey, agentName },
      model,
    );

    const initial =
      `Execute a subtarefa "${job.title}".\nEntregável esperado: ${job.deliverableGoal}\n\n${job.instructions}\n\n` +
      `Ao terminar, chame attach_deliverable com o artefato real.` +
      threadContextBlock(job.threadKey);

    let history: ModelMessage[] = [{ role: "user", content: initial }];
    for (let round = 0; ; round++) {
      const { text, newMessages } = await run(agent, history);
      if (text) await post(text);
      history = [...history, ...newMessages];
      if (round < MAX_INTERVIEW_ROUNDS && endedNeedingHuman(text, newMessages)) {
        track(cardKey, { column: "aprovacao" }, "aguardando suas respostas");
        const answer = await askQuestion(job.threadKey, text, agentName);
        track(cardKey, { column: "execucao" }, "resposta recebida — continuando");
        history.push({ role: "user", content: answer });
        continue;
      }
      break;
    }

    // Entrega honesta: só fecha ok se um entregável foi de fato anexado ao card.
    const card = listBoard().find((c) => c.key === cardKey);
    if (card?.deliverable) {
      track(cardKey, { column: "concluido", outcome: "ok" }, `entregue: ${card.deliverable.summary}`);
    } else {
      track(cardKey, { column: "concluido", outcome: "falha" }, "subtarefa encerrou sem entregável — nada foi anexado");
    }
  } catch (err) {
    track(cardKey, { column: "concluido", outcome: "falha" }, "erro na subtarefa");
    console.error("Erro no worker de subtarefa:", err);
    await post(`Tive um problema na subtarefa: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Worker das folhas: consome "subtask" e delega ao processador acima. */
export function startSubtaskWorker(messenger: Messenger, deps: SubtaskDeps = {}): void {
  queue.process("subtask", (job) => runSubtask(job, messenger, deps));
}

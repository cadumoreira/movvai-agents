import type { WebClient } from "@slack/web-api";
import { queue } from "../queue/index.js";
import { runAgent } from "../agent-runtime/run.js";
import { createDeliveryAgent } from "../agents/delivery.js";
import { track } from "../board/board.js";

/**
 * Worker do Delivery Manager: consome "delivery-summary" (acionado após a revisão do QA)
 * e publica um resumo de entrega na thread (e no ticket, quando houver).
 */
export function startDeliveryWorker(slack: WebClient): void {
  queue.process("delivery-summary", async (job) => {
    const post = (text: string) =>
      slack.chat.postMessage({ channel: job.channel, thread_ts: job.threadTs, text });

    const cardKey = `${job.threadKey}:delivery`;
    try {
      track(
        cardKey,
        { title: job.title, agent: "Dani (Delivery)", squad: "produto", column: "execucao" },
        "montando o resumo da entrega",
      );
      const delivery = createDeliveryAgent();
      const verdict =
        job.qaApproved === undefined
          ? "revisado pelo QA"
          : job.qaApproved
            ? "aprovado pelo QA"
            : "com mudanças solicitadas pelo QA";
      const idRef = job.ticketIdentifier ? `\nTicket: ${job.ticketIdentifier}` : "";
      const initial =
        `Resuma a entrega para o time.${idRef}\n\n` +
        `Demanda: ${job.title}\nPR: ${job.prUrl} (#${job.prNumber}) — ${verdict}.\n\n` +
        `Faça um resumo curto e, se houver identificador de ticket, registre o resumo nele.`;

      const { text } = await runAgent(delivery, [{ role: "user", content: initial }]);
      track(cardKey, { column: "concluido", outcome: "ok" }, "resumo publicado");
      if (text) await post(text);
    } catch (err) {
      track(cardKey, { column: "concluido", outcome: "falha" }, "erro ao resumir a entrega");
      console.error("Erro no worker do Delivery:", err);
      await post(`Tive um problema ao resumir a entrega: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Tarefa genérica da Dani (ex.: changelog compilado dos PRs mergeados, via rotina).
  queue.process("delivery-task", async (job) => {
    const post = (text: string) =>
      slack.chat.postMessage({ channel: job.channel, thread_ts: job.threadTs, text });
    // Sufixo próprio: a MESMA thread pode ter um delivery-summary — não dividir o card.
    const cardKey = `${job.threadKey}:delivery-task`;
    try {
      track(
        cardKey,
        { title: job.title, agent: "Dani (Delivery)", squad: "produto", column: "execucao" },
        "trabalhando na tarefa",
      );
      await post(`:package: Dani (Delivery) aqui — peguei *${job.title}*.`);
      const { text } = await runAgent(createDeliveryAgent(), [{ role: "user", content: job.instructions }]);
      track(cardKey, { column: "concluido", outcome: "ok" }, "tarefa concluída");
      if (text) await post(text);
    } catch (err) {
      track(cardKey, { column: "concluido", outcome: "falha" }, "erro na tarefa");
      console.error("Erro no worker do Delivery (task):", err);
      await post(`Tive um problema na tarefa: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

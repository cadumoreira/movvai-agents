import type { WebClient } from "@slack/web-api";
import { queue } from "../queue/index.js";
import { runAgent } from "../agent-runtime/run.js";
import { createDeliveryAgent } from "../agents/delivery.js";

/**
 * Worker do Delivery Manager: consome "delivery-summary" (acionado após a revisão do QA)
 * e publica um resumo de entrega na thread (e no ticket, quando houver).
 */
export function startDeliveryWorker(slack: WebClient): void {
  queue.process("delivery-summary", async (job) => {
    const post = (text: string) =>
      slack.chat.postMessage({ channel: job.channel, thread_ts: job.threadTs, text });

    try {
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
      if (text) await post(text);
    } catch (err) {
      console.error("Erro no worker do Delivery:", err);
      await post(`Tive um problema ao resumir a entrega: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

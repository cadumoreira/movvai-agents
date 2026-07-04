import type { WebClient } from "@slack/web-api";
import { queue } from "../queue/index.js";
import { runAgent } from "../agent-runtime/run.js";
import { createTechLeadAgent } from "../agents/tech-lead.js";
import { routeModel } from "../models/router.js";
import { config } from "../config.js";
import { track } from "../board/board.js";

/**
 * Worker do Tech Lead: consome "techlead-task", desenha a abordagem (sem sandbox —
 * trabalha por leitura do GitHub + Linear) e delega ao Dev. Tudo na mesma thread.
 */
export function startTechLeadWorker(slack: WebClient): void {
  queue.process("techlead-task", async (task) => {
    const post = (text: string) =>
      slack.chat.postMessage({ channel: task.channel, thread_ts: task.threadTs, text });

    const cardKey = `${task.threadKey}:techlead`;
    try {
      track(
        cardKey,
        { title: task.ticket.title, agent: "Rui (Tech Lead)", squad: "produto", column: "execucao" },
        "desenhando a abordagem técnica",
      );
      await post(
        `:triangular_ruler: Rui (Tech Lead) aqui — vou desenhar a abordagem de *${task.ticket.identifier ?? task.ticket.title}* e passar pro Dev.`,
      );
      const model = routeModel(config.models.dev, { text: task.instructions });
      const techLead = createTechLeadAgent(
        { channel: task.channel, threadTs: task.threadTs, threadKey: task.threadKey, slack },
        model,
      );

      const ticketRef = task.ticket.url ? `\nTicket: ${task.ticket.url}` : "";
      const idRef = task.ticket.identifier ? `\nIdentificador: ${task.ticket.identifier}` : "";
      const initial =
        `Defina a abordagem técnica para a demanda a seguir e delegue ao Dev.${ticketRef}${idRef}\n\n` +
        `${task.instructions}\n\nInvestigue o repositório, registre o design no ticket e chame delegate_to_dev.`;

      const { text } = await runAgent(techLead, [{ role: "user", content: initial }]);
      track(cardKey, { column: "concluido", outcome: "ok" }, "abordagem definida e delegada");
      if (text) await post(text);
    } catch (err) {
      track(cardKey, { column: "concluido", outcome: "falha" }, "erro ao desenhar a abordagem");
      console.error("Erro no worker do Tech Lead:", err);
      await post(`Tive um problema ao desenhar a abordagem: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

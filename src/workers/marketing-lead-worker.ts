import type { WebClient } from "@slack/web-api";
import { queue } from "../queue/index.js";
import { runAgent } from "../agent-runtime/run.js";
import { createMarketingLeadAgent } from "../agents/marketing-lead.js";
import { routeModel } from "../models/router.js";
import { config } from "../config.js";
import { track } from "../board/board.js";
import { formatPreflight } from "../deps/preflight.js";
import { preflightOrAbort } from "./support.js";

/**
 * Worker da Head de Marketing: consome "marketing-task", cria o brief no Notion e
 * delega as frentes às especialistas (jobs "marketing-work"). Tudo na mesma thread.
 */
export function startMarketingLeadWorker(slack: WebClient): void {
  queue.process("marketing-task", async (task) => {
    const post = (text: string) =>
      slack.chat.postMessage({ channel: task.channel, thread_ts: task.threadTs, text });

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
      const lead = createMarketingLeadAgent(
        { channel: task.channel, threadTs: task.threadTs, threadKey: task.threadKey, slack },
        task.brief,
        model,
      );

      const initial =
        `Planeje a demanda de marketing a seguir: crie o brief no Notion e delegue as frentes ` +
        `necessárias com assign_marketing_work (uma chamada por frente, com o page_id do brief).\n\n` +
        `Demanda: ${task.brief.title}\n\n${task.instructions}` +
        formatPreflight(checks);

      const { text } = await runAgent(lead, [{ role: "user", content: initial }]);
      track(cardKey, { column: "concluido", outcome: "ok" }, "brief pronto e frentes acionadas");
      if (text) await post(text);
    } catch (err) {
      track(cardKey, { column: "concluido", outcome: "falha" }, "erro ao planejar o brief");
      console.error("Erro no worker da Head de Marketing:", err);
      await post(
        `Tive um problema ao planejar a demanda: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

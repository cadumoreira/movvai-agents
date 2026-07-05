import type { WebClient } from "@slack/web-api";
import { queue } from "../queue/index.js";
import { runAgent } from "../agent-runtime/run.js";
import { createMarketingSpecialistAgent, specialistName } from "../agents/marketing-specialist.js";
import { slackApprover, type Approver } from "../approvals/gate.js";
import { routeModel } from "../models/router.js";
import { config } from "../config.js";
import { track } from "../board/board.js";
import { formatPreflight } from "../deps/preflight.js";
import { preflightOrAbort } from "./support.js";

/**
 * Worker das especialistas de marketing: consome "marketing-work", instancia a persona
 * da disciplina (Caio/Sofia/Leo/Nina), produz o entregável no Notion e pede aprovação
 * humana antes de dá-lo como publicável. Tudo na mesma thread do Slack.
 */
export function startMarketingWorker(slack: WebClient): void {
  queue.process("marketing-work", async (task) => {
    const post = (text: string) =>
      slack.chat.postMessage({ channel: task.channel, thread_ts: task.threadTs, text });

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
        "produzindo o entregável no Notion",
      );
      await post(
        `:art: ${specialistName(task.discipline)} aqui — peguei a frente de *${task.brief.title}*. Produzindo o entregável…`,
      );
      const model = routeModel(config.models.marketing, { text: task.instructions });
      const baseApprove = slackApprover(slack, task.channel, task.threadTs);
      const approve: Approver = async (opts) => {
        track(cardKey, { column: "aprovacao" }, "pediu OK humano para publicar");
        const decision = await baseApprove(opts);
        track(cardKey, { column: "execucao" }, decision.approved ? "publicação aprovada" : "publicação recusada");
        return decision;
      };
      const specialist = createMarketingSpecialistAgent(
        task.discipline,
        {
          approve,
          thread: { channel: task.channel, threadTs: task.threadTs, threadKey: task.threadKey, slack },
        },
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
        formatPreflight(checks);

      const { text } = await runAgent(specialist, [{ role: "user", content: initial }]);
      track(cardKey, { column: "concluido", outcome: "ok" }, "entregável finalizado");
      if (text) await post(text);
    } catch (err) {
      track(cardKey, { column: "concluido", outcome: "falha" }, "erro ao produzir o entregável");
      console.error("Erro no worker de marketing:", err);
      await post(
        `Tive um problema ao produzir o entregável: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

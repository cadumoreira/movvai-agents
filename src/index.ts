import { createPMAgent } from "./agents/pm.js";
import { createSlackApp } from "./connectors/slack.js";
import { createThreadMemory } from "./memory/thread-memory.js";
import { startDevWorker } from "./workers/dev-worker.js";
import { startQaWorker } from "./workers/qa-worker.js";
import { startTechLeadWorker } from "./workers/techlead-worker.js";
import { startDeliveryWorker } from "./workers/delivery-worker.js";
import { startMarketingLeadWorker } from "./workers/marketing-lead-worker.js";
import { startMarketingWorker } from "./workers/marketing-worker.js";
import { startScheduler } from "./schedule/scheduler.js";
import { routeModel } from "./models/router.js";
import { initTelemetry } from "./observability/otel.js";
import { startDashboard, type InboundHandler } from "./web/server.js";
import { queue } from "./queue/index.js";
import { track } from "./board/board.js";
import { config } from "./config.js";

/**
 * Fases 0 → 2 — Time conversacional no Slack.
 *
 * Fase 0: @Ana (PM) investiga (GitHub) e cria ticket (Linear).
 * Fase 1: Ana delega ao Téo (Dev) → sandbox E2B, implementa, PEDE APROVAÇÃO antes do PR.
 * Fase 2: roteamento de custo por modelo, orçamento de tokens, agente Bia (QA) revisa o
 *         PR (testes + comentário), e fila plugável (BullMQ/Redis se REDIS_URL existir).
 */
async function main() {
  initTelemetry(); // antes de qualquer chamada de modelo
  const memory = createThreadMemory();

  // O PM é roteado por custo: tarefas simples vão para um modelo barato.
  const app = createSlackApp(
    (ctx, userText) => createPMAgent(ctx, routeModel(config.models.pm, { text: userText })),
    memory,
  );

  // Workers reagem aos jobs (PM→Tech Lead→Dev→QA→Delivery) na mesma thread do Slack.
  startTechLeadWorker(app.client);
  startDevWorker(app.client);
  startQaWorker(app.client);
  startDeliveryWorker(app.client);

  // Squad de marketing (Malu coordena; Caio/Sofia/Leo/Nina executam no Notion).
  startMarketingLeadWorker(app.client);
  startMarketingWorker(app.client);

  // Rotinas agendadas (cron): o time trabalha proativamente (schedules.json).
  startScheduler(app.client);

  // Webhooks de entrada (GitHub/Linear) → posta no canal padrão e aciona o Tech Lead.
  const handleInbound: InboundHandler = async (source, task) => {
    const channel = config.slack.defaultChannel;
    if (!channel) {
      console.warn(`Webhook do ${source} ignorado: defina SLACK_DEFAULT_CHANNEL para rotear.`);
      return;
    }
    const posted = await app.client.chat.postMessage({
      channel,
      text: `:inbox_tray: Recebi do ${source}: *${task.title}* — passando pro time.`,
    });
    const threadTs = String(posted.ts);
    track(
      `${channel}:${threadTs}:techlead`,
      { title: task.title, agent: "Rui (Tech Lead)", squad: "produto", column: "fila" },
      `demanda recebida por webhook (${source})`,
    );
    await queue.enqueue("techlead-task", {
      channel,
      threadTs,
      threadKey: `${channel}:${threadTs}`,
      ticket: { title: task.title, url: task.url, identifier: task.identifier },
      instructions: task.instructions,
    });
  };

  startDashboard(config.dashboard.port, handleInbound);

  await app.start();
  console.log(
    JSON.stringify({
      level: "info",
      kind: "startup",
      message:
        "Dream team online — Ana (PM), Rui (Tech Lead), Téo (Dev), Bia (QA) e Dani (Delivery) no Slack; " +
        "squad de marketing: Malu (Head), Caio (Conteúdo), Sofia (Social), Leo (Ads) e Nina (SEO).",
      models: {
        pm: config.models.pm,
        dev: config.models.dev,
        qa: config.models.qa,
        marketing: config.models.marketing,
        cheap: config.models.cheap,
      },
      marketingBoard: config.notion.apiKey ? "notion" : "off",
      queue: config.redisUrl ? "bullmq" : "in-process",
      memory: config.databaseUrl ? "pgvector" : "off",
      at: new Date().toISOString(),
    }),
  );
}

main().catch((err) => {
  console.error("Falha ao iniciar:", err);
  process.exit(1);
});

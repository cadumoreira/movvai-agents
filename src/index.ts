import { createPMAgent } from "./agents/pm.js";
import { createSlackApp } from "./connectors/slack.js";
import { dispatchMention } from "./connectors/dispatch.js";
import { PanelMessenger, type Messenger } from "./messaging/messenger.js";
import { initConversations } from "./messaging/conversations.js";
import { splitThreadKey } from "./approvals/reminders.js";
import { createThreadMemory } from "./memory/thread-memory.js";
import { startDevWorker } from "./workers/dev-worker.js";
import { startQaWorker } from "./workers/qa-worker.js";
import { startTechLeadWorker } from "./workers/techlead-worker.js";
import { startDeliveryWorker } from "./workers/delivery-worker.js";
import { startMarketingLeadWorker } from "./workers/marketing-lead-worker.js";
import { startMarketingWorker } from "./workers/marketing-worker.js";
import { startOpsWorker } from "./workers/ops-worker.js";
import { startScheduler } from "./schedule/scheduler.js";
import { startReminders } from "./approvals/reminders.js";
import { routeModel } from "./models/router.js";
import { initTelemetry } from "./observability/otel.js";
import { startDashboard, type InboundHandler, type ChatHandler } from "./web/server.js";
import { queue } from "./queue/index.js";
import { track, initBoard, sweepStaleCards } from "./board/board.js";
import { opsSpecialistName } from "./agents/ops-specialist.js";
import type { OpsDiscipline } from "./queue/types.js";
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
  await initBoard(); // restaura o board da persistência (Redis), se houver
  await initConversations(); // restaura as conversas (thread interna) do Redis, se houver

  // Vigia: frente parada em fila/execução além do limite vira falha explícita.
  if (config.jobs.staleCardMinutes > 0) {
    setInterval(() => {
      const swept = sweepStaleCards(config.jobs.staleCardMinutes * 60_000);
      if (swept.length) console.warn(`[vigia] ${swept.length} frente(s) órfã(s) marcadas como falha.`);
    }, 60_000);
  }

  const memory = createThreadMemory();

  // O PM é roteado por custo: tarefas simples vão para um modelo barato.
  const agentFactory = (ctx: import("./agents/context.js").AgentContext, userText: string) =>
    createPMAgent(ctx, routeModel(config.models.pm, { text: userText }));

  // Slack é OPCIONAL. Com as chaves, o Slack é a superfície (e o messenger). Sem elas,
  // o time roda 100% pelo painel (PanelMessenger) + webhooks + rotinas.
  let messenger: Messenger;
  let slackApp: ReturnType<typeof createSlackApp>["app"] | undefined;
  if (config.slack.enabled) {
    const created = createSlackApp(agentFactory, memory);
    slackApp = created.app;
    messenger = created.messenger;
  } else {
    messenger = new PanelMessenger();
    console.warn(
      JSON.stringify({ level: "info", kind: "surface", message: "Slack desativado — rodando em modo painel.", at: new Date().toISOString() }),
    );
  }

  // Workers reagem aos jobs (PM→Tech Lead→Dev→QA→Delivery) na mesma thread.
  startTechLeadWorker(messenger);
  startDevWorker(messenger);
  startQaWorker(messenger);
  startDeliveryWorker(messenger);

  // Squad de marketing (Malu coordena; Caio/Sofia/Leo/Nina executam no Notion).
  startMarketingLeadWorker(messenger);
  startMarketingWorker(messenger);

  // Squad de operações (Igor/SDR, Lia/Suporte, Otto/Financeiro).
  startOpsWorker(messenger);

  // Rotinas agendadas (cron): o time trabalha proativamente (schedules.json).
  startScheduler(messenger);

  // Lembretes de pendência humana (aprovações/perguntas paradas ganham cutucada).
  startReminders(messenger);

  // Webhooks de entrada (GitHub/Linear) → abre uma thread (Slack ou interna) e aciona o Tech Lead.
  const handleInbound: InboundHandler = async (source, task) => {
    const base = await messenger.openThread(`:inbox_tray: Recebi do ${source}: *${task.title}* — passando pro time.`);
    if (!base) {
      console.warn(`Webhook do ${source} ignorado: sem canal para ancorar (defina SLACK_DEFAULT_CHANNEL ou rode o painel).`);
      return;
    }
    track(
      `${base.threadKey}:techlead`,
      { title: task.title, agent: "Rui (Tech Lead)", squad: "produto", column: "fila" },
      `demanda recebida por webhook (${source})`,
    );
    await queue.enqueue("techlead-task", {
      ...base,
      ticket: { title: task.title, url: task.url, identifier: task.identifier },
      instructions: task.instructions,
    });
  };

  // Nova demanda PELO PAINEL: abre a thread (interna no modo painel, real no Slack) + squad certo.
  const handleDemand = async (squad: "produto" | "marketing" | OpsDiscipline, text: string) => {
    const base = await messenger.openThread(`:desktop_computer: Demanda criada pelo painel: *${text.slice(0, 120)}*`);
    if (!base) return { ok: false as const, error: "Sem canal para ancorar: defina SLACK_DEFAULT_CHANNEL ou rode em modo painel." };
    const title = text.slice(0, 80);
    if (squad === "produto") {
      track(`${base.threadKey}:techlead`, { title, agent: "Rui (Tech Lead)", squad: "produto", column: "fila" }, "demanda criada pelo painel");
      await queue.enqueue("techlead-task", { ...base, ticket: { title }, instructions: text });
    } else if (squad === "marketing") {
      track(`${base.threadKey}:marketing-lead`, { title, agent: "Malu (Head de Marketing)", squad: "marketing", column: "fila" }, "demanda criada pelo painel");
      await queue.enqueue("marketing-task", { ...base, brief: { title }, instructions: text });
    } else {
      track(`${base.threadKey}:ops-${squad}`, { title, agent: opsSpecialistName(squad), squad: "operacoes", column: "fila" }, "demanda criada pelo painel");
      await queue.enqueue("ops-task", { ...base, discipline: squad, title, instructions: text });
    }
    return { ok: true as const };
  };

  // Chat pelo painel: mesma lógica de uma menção no Slack (dispatchMention), na thread do card.
  const handleChat: ChatHandler = async (threadKey, text) => {
    const parts = splitThreadKey(threadKey);
    if (!parts) return { ok: false, error: "thread inválida" };
    await dispatchMention(
      text,
      { channel: parts.channel, threadTs: parts.threadTs, threadKey },
      { messenger, agentFactory, memory, actor: "painel", humanLabel: "você" },
    );
    return { ok: true };
  };

  startDashboard(config.dashboard.port, handleInbound, handleDemand, handleChat);

  // Defaults abertos são para uso LOCAL: em produção, avise alto.
  if (!config.security.dashboardToken || config.security.approverSlackIds.length === 0) {
    console.warn(
      JSON.stringify({
        level: "warn",
        kind: "security",
        message:
          "Modo aberto: defina DASHBOARD_TOKEN (painel) e APPROVER_SLACK_IDS (quem aprova) em produção — " +
          "sem eles, qualquer pessoa com acesso à porta lê/edita playbooks e qualquer membro do canal aprova.",
        at: new Date().toISOString(),
      }),
    );
  }

  if (slackApp) await slackApp.start();
  console.log(
    JSON.stringify({
      level: "info",
      kind: "startup",
      message:
        "Dream team online — Ana (PM), Rui (Tech Lead), Téo (Dev), Bia (QA) e Dani (Delivery); " +
        "squad de marketing: Malu, Caio, Sofia, Leo e Nina; operações: Igor (SDR), Lia (Suporte) e Otto (Financeiro).",
      surface: config.slack.enabled ? "slack+painel" : "painel",
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

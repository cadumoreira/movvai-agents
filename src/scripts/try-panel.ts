import "dotenv/config";
import { queue } from "../queue/index.js";
import { startMarketingLeadWorker } from "../workers/marketing-lead-worker.js";
import { startMarketingWorker } from "../workers/marketing-worker.js";
import { startDashboard } from "../web/server.js";
import { dispatchMention } from "../connectors/dispatch.js";
import { createPMAgent } from "../agents/pm.js";
import { routeModel } from "../models/router.js";
import { splitThreadKey } from "../approvals/reminders.js";
import { createThreadMemory } from "../memory/thread-memory.js";
import { listPending, resolvePending } from "../approvals/registry.js";
import { PanelMessenger } from "../messaging/messenger.js";
import { config } from "../config.js";

/**
 * Sobe o time em MODO PAINEL — 100% sem Slack. Prova o desacoplamento: demandas,
 * chat, aprovações, perguntas e rotinas funcionam só pelo painel web.
 *
 *   MARKETING_MODEL=mock:marketing CHEAP_MODEL=mock:marketing PM_MODEL=mock:pm npm run try:panel
 *   # abra http://localhost:3000 — crie uma demanda, abra o card, converse no chat.
 */
async function main() {
  const messenger = new PanelMessenger();
  const memory = createThreadMemory();
  const agentFactory = (ctx: import("../agents/context.js").AgentContext, userText: string) =>
    createPMAgent(ctx, routeModel(config.models.pm, { text: userText }));

  startMarketingLeadWorker(messenger);
  startMarketingWorker(messenger);

  const handleDemand = async (squad: "pm" | "produto" | "marketing" | "sdr" | "suporte" | "financeiro", text: string) => {
    const base = await messenger.openThread(`:desktop_computer: Demanda: *${text.slice(0, 120)}*`);
    if (squad === "marketing") await queue.enqueue("marketing-task", { ...base, brief: { title: text.slice(0, 80) }, instructions: text });
    return { ok: true };
  };
  const handleChat = async (threadKey: string, text: string) => {
    const parts = splitThreadKey(threadKey);
    if (!parts) return { ok: false, error: "thread inválida" };
    await dispatchMention(text, { channel: parts.channel, threadTs: parts.threadTs, threadKey }, { messenger, agentFactory, memory, actor: "painel", humanLabel: "você" });
    return { ok: true };
  };

  // Aprovação automática (para o smoke não travar) — no uso real você decide no painel.
  if (process.env.AUTO_APPROVE !== "off") {
    setInterval(() => {
      for (const a of listPending()) resolvePending(a.id, { approved: true }, "try:panel");
    }, 500);
  }

  startDashboard(config.dashboard.port, undefined, handleDemand, handleChat);
  console.log(`\n▶ Modo painel (sem Slack) no ar: http://localhost:${config.dashboard.port}`);
  console.log(`  Slack habilitado? ${config.slack.enabled} · aprovação auto: ${process.env.AUTO_APPROVE !== "off"}`);
}

main().catch((err) => {
  console.error("Falha no modo painel:", err);
  process.exit(1);
});

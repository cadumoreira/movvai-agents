import "dotenv/config";
import { queue } from "../queue/index.js";
import { startMarketingLeadWorker } from "../workers/marketing-lead-worker.js";
import { startMarketingWorker } from "../workers/marketing-worker.js";
import { startDashboard } from "../web/server.js";
import { listPending, resolvePending } from "../approvals/registry.js";
import { listBoard } from "../board/board.js";
import { PanelMessenger } from "../messaging/messenger.js";
import { config } from "../config.js";

/**
 * E2E do squad de marketing SEM Slack: demanda → Malu (brief) → Sofia (frente social)
 * → Vera (revisão) → aprovação humana → entregável. Fila, board, portão e preflight
 * são os REAIS; o Slack vira o terminal.
 *
 * Com chave de provedor:   npm run try:marketing -- "peça de lançamento no Instagram"
 * Sem chave (fluxo/dry):   MARKETING_MODEL=mock:marketing CHEAP_MODEL=mock:marketing npm run try:marketing
 * Aprovar manualmente:     AUTO_APPROVE=off (decida no painel http://localhost:3000)
 */

const title = process.argv[2] || "Peça de lançamento no Instagram";
const instructions =
  process.argv[3] ||
  `Somos uma EMPRESA NOVA fazendo o primeiro post no Instagram. Objetivo: apresentar a marca ` +
    `e levar visita ao site. Use o perfil e o brand book da marca. Uma peça única (legenda + criativo descrito).`;
const autoApprove = process.env.AUTO_APPROVE !== "off";

// Sem Slack: o PanelMessenger grava a conversa na thread interna (visível no painel);
// aqui também espelhamos no terminal para acompanhar o fluxo.
const messenger = new PanelMessenger();
const origPost = messenger.post.bind(messenger);
messenger.post = async (target, text, from) => {
  console.log(`\n💬 [${from ?? "sistema"}] ${text}`);
  return origPost(target, text, from);
};

async function main() {
  console.log(`\n▶ E2E marketing: "${title}"`);
  console.log(`  modelo do squad: ${config.models.marketing} · revisão da Vera: ${config.marketingReview ? "on" : "off"}`);
  console.log(`  aprovação: ${autoApprove ? "automática (simulando seu clique)" : "manual — decida no painel :" + config.dashboard.port}\n`);

  startDashboard(config.dashboard.port); // acompanhe o board ao vivo
  startMarketingLeadWorker(messenger);
  startMarketingWorker(messenger);

  // Simula (ou delega ao painel) o clique humano no portão de aprovação.
  const approver = setInterval(() => {
    for (const a of listPending()) {
      if (!autoApprove) {
        console.log(`\n⏸  Aprovação pendente (decida no painel): ${a.text.slice(0, 100)}…`);
        continue;
      }
      console.log(`\n🖱️  [humano simulado] Aprovando: ${a.text.replace(/\n/g, " ").slice(0, 110)}…`);
      resolvePending(a.id, { approved: true }, "try:auto");
    }
  }, 500);

  // A demanda entra como se a Ana tivesse delegado (mesmo job real).
  await queue.enqueue("marketing-task", {
    channel: "terminal",
    threadTs: "1",
    threadKey: "terminal:1",
    brief: { title },
    instructions,
  });

  // Espera a frente social concluir (ou estoura o tempo com diagnóstico).
  const deadline = Date.now() + 180_000;
  for (;;) {
    const social = listBoard().find((c) => c.key === "terminal:1:mkt-social");
    if (social?.column === "concluido") break;
    if (Date.now() > deadline) {
      console.error("\n✗ Timeout: a frente social não concluiu em 3min. Board:", JSON.stringify(listBoard(), null, 1));
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  clearInterval(approver);

  console.log("\n── Resultado do board ─────────────────────────────────────────");
  for (const c of listBoard().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
    console.log(`  ${c.agent} → ${c.column}${c.outcome ? ` (${c.outcome})` : ""}`);
    for (const n of c.notes) console.log(`     · ${n.text}`);
  }
  console.log("\n✓ Fluxo completo: demanda → Malu → Sofia → Vera → aprovação → entregável.");
  console.log(`  Painel segue no ar em http://localhost:${config.dashboard.port} (Ctrl+C para sair).`);
}

main().catch((err) => {
  console.error("Falha no E2E:", err);
  process.exit(1);
});

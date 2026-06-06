import { createPMAgent } from "./agents/pm.js";
import { createSlackApp } from "./connectors/slack.js";
import { InMemoryThreadMemory } from "./memory/thread-memory.js";
import { startDevWorker } from "./workers/dev-worker.js";
import { config } from "./config.js";

/**
 * Fases 0 + 1 — Time conversacional no Slack.
 *
 * Fase 0: você menciona @Ana (PM) com um bug → ela investiga (GitHub) e cria ticket (Linear).
 * Fase 1: a Ana delega ao Téo (Dev) → ele trabalha num sandbox E2B, implementa, roda testes
 *         e PEDE SUA APROVAÇÃO no Slack antes de abrir o PR.
 */
async function main() {
  const memory = new InMemoryThreadMemory();
  const app = createSlackApp((ctx) => createPMAgent(ctx), memory);

  // Worker do Dev reage à delegação do PM e posta na mesma thread.
  startDevWorker(app.client);

  await app.start();
  console.log(
    JSON.stringify({
      level: "info",
      kind: "startup",
      message: "Dream team online — Ana (PM) e Téo (Dev) escutando o Slack.",
      models: { pm: config.models.pm, dev: config.models.dev },
      at: new Date().toISOString(),
    }),
  );
}

main().catch((err) => {
  console.error("Falha ao iniciar:", err);
  process.exit(1);
});

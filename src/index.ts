import { createPMAgent } from "./agents/pm.js";
import { createSlackApp } from "./connectors/slack.js";
import { InMemoryThreadMemory } from "./memory/thread-memory.js";
import { startDevWorker } from "./workers/dev-worker.js";
import { startQaWorker } from "./workers/qa-worker.js";
import { routeModel } from "./models/router.js";
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
  const memory = new InMemoryThreadMemory();

  // O PM é roteado por custo: tarefas simples vão para um modelo barato.
  const app = createSlackApp(
    (ctx, userText) => createPMAgent(ctx, routeModel(config.models.pm, { text: userText })),
    memory,
  );

  // Workers reagem aos jobs (delegação PM→Dev e Dev→QA) na mesma thread do Slack.
  startDevWorker(app.client);
  startQaWorker(app.client);

  await app.start();
  console.log(
    JSON.stringify({
      level: "info",
      kind: "startup",
      message: "Dream team online — Ana (PM), Téo (Dev) e Bia (QA) no Slack.",
      models: { pm: config.models.pm, dev: config.models.dev, qa: config.models.qa, cheap: config.models.cheap },
      queue: config.redisUrl ? "bullmq" : "in-process",
      at: new Date().toISOString(),
    }),
  );
}

main().catch((err) => {
  console.error("Falha ao iniciar:", err);
  process.exit(1);
});

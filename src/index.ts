import { createPMAgent } from "./agents/pm.js";
import { createSlackApp } from "./connectors/slack.js";
import { InMemoryThreadMemory } from "./memory/thread-memory.js";

/**
 * Fase 0 — Um agente conversacional no Slack (PM) + Linear + GitHub-read.
 *
 * Fluxo demonstrável: você menciona a @Ana no Slack com um bug/ideia → ela investiga
 * o repositório (GitHub), conversa e cria um ticket refinado no Linear.
 */
async function main() {
  const memory = new InMemoryThreadMemory();
  const pm = createPMAgent();
  const app = createSlackApp(pm, memory);

  await app.start();
  console.log(
    JSON.stringify({
      level: "info",
      kind: "startup",
      message: `Dream team online. Agente "${pm.name}" escutando menções no Slack.`,
      model: pm.model,
      at: new Date().toISOString(),
    }),
  );
}

main().catch((err) => {
  console.error("Falha ao iniciar:", err);
  process.exit(1);
});

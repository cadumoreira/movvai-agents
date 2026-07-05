import "dotenv/config";
import { createPMAgent } from "../agents/pm.js";
import { runAgent } from "../agent-runtime/run.js";
import { PanelMessenger } from "../messaging/messenger.js";
import { initTelemetry } from "../observability/otel.js";

/**
 * Smoke test do PM, no terminal — SEM Slack.
 * Valida modelo + Linear (+ GitHub se configurado): você passa um "bug" e vê a Ana
 * investigar e criar o ticket.
 *
 *   npm run try:pm -- "tem um bug no reset de senha em produção"
 */
const input =
  process.argv.slice(2).join(" ") ||
  "Tem um bug: usuários não conseguem resetar a senha em produção.";

async function main() {
  initTelemetry();
  const pm = createPMAgent({ channel: "cli", threadTs: "cli", threadKey: "cli", messenger: new PanelMessenger() });
  console.log(`\n> Você: ${input}\n`);
  console.log("…Ana trabalhando (investigando e criando ticket)…\n");
  const { text } = await runAgent(pm, [{ role: "user", content: input }]);
  console.log(`> Ana (PM):\n${text}\n`);
}

main().catch((err) => {
  console.error("Falhou:", err);
  process.exit(1);
});

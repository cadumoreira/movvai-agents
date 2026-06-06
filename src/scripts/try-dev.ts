import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createDevAgent } from "../agents/dev.js";
import { runAgent } from "../agent-runtime/run.js";
import { createRepoSandbox, parseRepo, REPO_DIR } from "../sandbox/e2b.js";
import { initTelemetry } from "../observability/otel.js";
import type { Approver } from "../approvals/gate.js";

/**
 * Smoke test do Dev, no terminal — SEM Slack.
 * Sobe um sandbox E2B, clona GITHUB_DEFAULT_REPO, roda o Téo numa demanda e pede a
 * aprovação do PR aqui no terminal (y/n).
 *
 *   npm run try:dev -- "adicione uma seção 'Testes' no README"
 *
 * Requer: E2B_API_KEY, GITHUB_TOKEN (com write) e GITHUB_DEFAULT_REPO.
 * Use um repositório de TESTE — o Dev abre um PR de verdade quando aprovado.
 */
const instructions =
  process.argv.slice(2).join(" ") || "Adicione uma seção 'Testes' no README explicando como rodar.";

const terminalApprover: Approver = async ({ text }) => {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ans = await rl.question(`\n[APROVAÇÃO]\n${text}\n\nAprovar e abrir PR? (y/n) `);
  rl.close();
  return { approved: ans.trim().toLowerCase().startsWith("y") };
};

async function main() {
  initTelemetry();
  const target = parseRepo(process.env.GITHUB_DEFAULT_REPO);
  console.log(`Subindo sandbox e clonando ${target.owner}/${target.repo}…`);
  const sandbox = await createRepoSandbox(target);
  try {
    const dev = createDevAgent({ sandbox, target, approve: terminalApprover });
    const initial =
      `Implemente a seguinte demanda: ${instructions}\n\n` +
      `O repositório está clonado em ${REPO_DIR}. Investigue, implemente, rode os testes ` +
      `e chame request_pr_approval quando estiver pronto.`;
    console.log("\n…Téo trabalhando no sandbox…\n");
    const { text } = await runAgent(dev, [{ role: "user", content: initial }]);
    console.log(`\n> Téo (Dev):\n${text}\n`);
  } finally {
    await sandbox.kill().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("Falhou:", err);
  process.exit(1);
});

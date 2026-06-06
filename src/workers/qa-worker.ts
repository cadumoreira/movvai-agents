import type { WebClient } from "@slack/web-api";
import type { Sandbox } from "e2b";
import { queue } from "../queue/index.js";
import { runAgent } from "../agent-runtime/run.js";
import { createQaAgent } from "../agents/qa.js";
import { createRepoSandbox, parseRepo, REPO_DIR } from "../sandbox/e2b.js";

/**
 * Worker do QA: consome jobs "qa-review" (acionados quando o Dev abre um PR), sobe um
 * sandbox com a branch do PR, roda a verificação determinística (testes) e a revisão.
 */
export function startQaWorker(slack: WebClient): void {
  queue.process("qa-review", async (job) => {
    const post = (text: string) =>
      slack.chat.postMessage({ channel: job.channel, thread_ts: job.threadTs, text });

    let sandbox: Sandbox | undefined;
    try {
      const target = parseRepo(job.repo);
      await post(`:mag: Bia (QA) aqui — revisando o PR de *${job.title}* (${job.prUrl})…`);

      sandbox = await createRepoSandbox(target);
      // A branch do PR já veio no clone (o host criou a ref antes). Checkout offline,
      // sem precisar de token para fetch.
      const checkout = await sandbox.commands.run(`git checkout ${job.branch}`, {
        cwd: REPO_DIR,
        timeoutMs: 60_000,
      });
      if (checkout.exitCode !== 0) {
        await post(`Não consegui acessar a branch \`${job.branch}\` para revisar: ${checkout.stderr}`);
        return;
      }

      const qa = createQaAgent({ sandbox, target, prNumber: job.prNumber });
      const initial =
        `Revise o PR "#${job.prNumber}: ${job.title}" (${job.prUrl}). A branch \`${job.branch}\` ` +
        `está em ${REPO_DIR}. Veja o diff, rode os testes/lint, avalie e registre a revisão com comment_on_pr.`;

      const { text } = await runAgent(qa, [{ role: "user", content: initial }]);
      if (text) await post(text);

      // Handoff QA → Delivery: resume a entrega.
      await queue.enqueue("delivery-summary", {
        channel: job.channel,
        threadTs: job.threadTs,
        threadKey: job.threadKey,
        title: job.title,
        prUrl: job.prUrl,
        prNumber: job.prNumber,
      });
    } catch (err) {
      console.error("Erro no worker do QA:", err);
      await post(`Tive um problema ao revisar o PR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (sandbox) await sandbox.kill().catch(() => undefined);
    }
  });
}

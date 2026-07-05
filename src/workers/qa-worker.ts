import type { WebClient } from "@slack/web-api";
import { queue } from "../queue/index.js";
import { runAgent } from "../agent-runtime/run.js";
import { createQaAgent } from "../agents/qa.js";
import { createRepoSandbox, parseRepo, type Sandbox } from "../sandbox/index.js";
import { getPullRequestFiles } from "../tools/github-write.js";
import { track } from "../board/board.js";
import { routeModel } from "../models/router.js";
import { config } from "../config.js";
import { formatPreflight } from "../deps/preflight.js";
import { preflightOrAbort } from "./support.js";

/**
 * Worker do QA: consome jobs "qa-review" (acionados quando o Dev abre um PR), sobe um
 * sandbox com a branch do PR, roda a verificação determinística (testes) e a revisão.
 */
export function startQaWorker(slack: WebClient): void {
  queue.process("qa-review", async (job) => {
    const post = (text: string) =>
      slack.chat.postMessage({ channel: job.channel, thread_ts: job.threadTs, text });

    const cardKey = `${job.threadKey}:qa`;
    const checks = await preflightOrAbort("qa", { cardKey, title: job.title, agent: "Bia (QA)", squad: "produto" }, post);
    if (!checks) return;
    let sandbox: Sandbox | undefined;
    try {
      const target = parseRepo(job.repo);
      track(
        cardKey,
        { title: job.title, agent: "Bia (QA)", squad: "produto", column: "execucao" },
        `revisando o PR #${job.prNumber}`,
      );
      await post(`:mag: Bia (QA) aqui — revisando o PR de *${job.title}* (${job.prUrl})…`);

      // O host traz a branch do PR via tarball (sem token no sandbox).
      sandbox = await createRepoSandbox(target, { ref: job.branch });

      // Resumo do diff (host-side, via API) para orientar a revisão.
      const files = await getPullRequestFiles(target, job.prNumber).catch(() => []);
      const fileList = files
        .map((f) => `- ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`)
        .join("\n");

      const qa = createQaAgent({ sandbox, target, prNumber: job.prNumber }, routeModel(config.models.qa, { text: job.title }));
      const initial =
        `Revise o PR "#${job.prNumber}: ${job.title}" (${job.prUrl}). O conteúdo da branch \`${job.branch}\` ` +
        `está disponível no sandbox (use caminhos relativos).\n\nArquivos alterados:\n${fileList || "(não foi possível obter a lista)"}\n\n` +
        `Leia os arquivos relevantes, rode os testes/lint, avalie e registre a revisão com comment_on_pr.` +
        formatPreflight(checks);

      const { text } = await runAgent(qa, [{ role: "user", content: initial }]);
      track(cardKey, { column: "concluido", outcome: "ok" }, "revisão registrada no PR");
      if (text) await post(text);

      // Handoff QA → Delivery: resume a entrega.
      track(
        `${job.threadKey}:delivery`,
        { title: job.title, agent: "Dani (Delivery)", squad: "produto", column: "fila" },
        "entrega passada ao Delivery",
      );
      await queue.enqueue("delivery-summary", {
        channel: job.channel,
        threadTs: job.threadTs,
        threadKey: job.threadKey,
        title: job.title,
        prUrl: job.prUrl,
        prNumber: job.prNumber,
      });
    } catch (err) {
      track(cardKey, { column: "concluido", outcome: "falha" }, "erro na revisão do PR");
      console.error("Erro no worker do QA:", err);
      await post(`Tive um problema ao revisar o PR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (sandbox) await sandbox.kill().catch(() => undefined);
    }
  });
}

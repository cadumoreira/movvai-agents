import type { WebClient } from "@slack/web-api";
import type { Sandbox } from "e2b";
import { bus } from "../events/bus.js";
import { runAgent } from "../agent-runtime/run.js";
import { createDevAgent } from "../agents/dev.js";
import { createRepoSandbox, parseRepo, REPO_DIR } from "../sandbox/e2b.js";

/**
 * Worker do Dev: reage ao evento de delegação, sobe um sandbox efêmero, roda o
 * agente Dev e, ao final, encerra o sandbox. Toda a comunicação acontece na mesma
 * thread do Slack (handoff observável).
 */
export function startDevWorker(slack: WebClient): void {
  bus.on("dev.task.requested", async (task) => {
    const post = (text: string) =>
      slack.chat.postMessage({ channel: task.channel, thread_ts: task.threadTs, text });

    let sandbox: Sandbox | undefined;
    try {
      const target = parseRepo(task.repo);
      await post(
        `:wave: Téo (Dev) aqui — peguei *${task.ticket.identifier ?? task.ticket.title}*. Subindo o ambiente e investigando o código…`,
      );

      sandbox = await createRepoSandbox(target);
      const dev = createDevAgent({
        sandbox,
        target,
        agent: {
          channel: task.channel,
          threadTs: task.threadTs,
          threadKey: task.threadKey,
          slack,
        },
      });

      const ticketRef = task.ticket.url ? `\nTicket: ${task.ticket.url}` : "";
      const initial =
        `Implemente a seguinte demanda.${ticketRef}\n\n${task.instructions}\n\n` +
        `O repositório já está clonado em ${REPO_DIR}. Investigue, implemente, rode os testes e, ` +
        `quando estiver pronto e verde, chame request_pr_approval para pedir o OK antes de abrir o PR.`;

      const { text } = await runAgent(dev, [{ role: "user", content: initial }]);
      if (text) await post(text);
    } catch (err) {
      console.error("Erro no worker do Dev:", err);
      await post(`Tive um problema ao trabalhar na demanda: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (sandbox) await sandbox.kill().catch(() => undefined);
    }
  });
}

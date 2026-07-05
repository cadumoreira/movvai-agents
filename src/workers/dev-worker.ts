import { queue } from "../queue/index.js";
import { runAgent } from "../agent-runtime/run.js";
import { createDevAgent } from "../agents/dev.js";
import { createRepoSandbox, parseRepo, type Sandbox } from "../sandbox/index.js";
import { type Approver } from "../approvals/gate.js";
import type { Messenger } from "../messaging/messenger.js";
import { routeModel } from "../models/router.js";
import { config } from "../config.js";
import { track } from "../board/board.js";
import { formatPreflight } from "../deps/preflight.js";
import { preflightOrAbort } from "./support.js";

/**
 * Worker do Dev: consome jobs "dev-task", sobe um sandbox efêmero, roda o agente Dev
 * e encerra o sandbox. Toda a comunicação acontece na mesma thread do Slack.
 */
export function startDevWorker(messenger: Messenger): void {
  queue.process("dev-task", async (task) => {
    const post = (text: string) => messenger.post({ channel: task.channel, threadTs: task.threadTs }, text, "Téo (Dev)");

    const cardKey = `${task.threadKey}:dev`;
    // Preflight: dependência ESSENCIAL ausente aborta ANTES de subir sandbox/gastar tokens.
    const checks = await preflightOrAbort("dev", { cardKey, title: task.ticket.title, agent: "Téo (Dev)", squad: "produto" }, post);
    if (!checks) return;
    let sandbox: Sandbox | undefined;
    try {
      const target = parseRepo(task.repo);
      track(
        cardKey,
        { title: task.ticket.title, agent: "Téo (Dev)", squad: "produto", column: "execucao" },
        "subindo o sandbox e investigando",
      );
      await post(
        `:wave: Téo (Dev) aqui — peguei *${task.ticket.identifier ?? task.ticket.title}*. Subindo o ambiente e investigando o código…`,
      );

      sandbox = await createRepoSandbox(target);
      const model = routeModel(config.models.dev, { text: task.instructions });
      const baseApprove = messenger.approver({ channel: task.channel, threadTs: task.threadTs, threadKey: task.threadKey });
      const approve: Approver = async (opts) => {
        track(cardKey, { column: "aprovacao" }, "pediu OK humano para abrir o PR");
        const decision = await baseApprove(opts);
        track(cardKey, { column: "execucao" }, decision.approved ? "PR aprovado pelo humano" : "PR recusado pelo humano");
        return decision;
      };
      const dev = createDevAgent(
        {
          sandbox,
          target,
          approve,
          thread: { channel: task.channel, threadTs: task.threadTs, threadKey: task.threadKey },
        },
        model,
      );

      const ticketRef = task.ticket.url ? `\nTicket: ${task.ticket.url}` : "";
      const initial =
        `Implemente a seguinte demanda.${ticketRef}\n\n${task.instructions}\n\n` +
        `O repositório já está disponível no sandbox (use caminhos relativos). Investigue, implemente, rode os testes e, ` +
        `quando estiver pronto e verde, chame request_pr_approval para pedir o OK antes de abrir o PR.` +
        formatPreflight(checks);

      const { text } = await runAgent(dev, [{ role: "user", content: initial }]);
      track(cardKey, { column: "concluido", outcome: "ok" }, "frente encerrada");
      if (text) await post(text);
    } catch (err) {
      track(cardKey, { column: "concluido", outcome: "falha" }, "erro durante a implementação");
      console.error("Erro no worker do Dev:", err);
      await post(
        `Tive um problema ao trabalhar na demanda: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (sandbox) await sandbox.kill().catch(() => undefined);
    }
  });
}

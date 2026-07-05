import type { WebClient } from "@slack/web-api";
import { queue } from "../queue/index.js";
import { runAgent } from "../agent-runtime/run.js";
import { createOpsSpecialistAgent, opsSpecialistName } from "../agents/ops-specialist.js";
import { slackApprover, type Approver } from "../approvals/gate.js";
import { routeModel } from "../models/router.js";
import { config } from "../config.js";
import { track } from "../board/board.js";
import { formatPreflight } from "../deps/preflight.js";
import { preflightOrAbort } from "./support.js";

/**
 * Worker do squad de Operações: consome "ops-task", instancia a persona da disciplina
 * (Igor/Lia/Otto) e trabalha na thread — com portão de aprovação antes de qualquer envio.
 */
export function startOpsWorker(slack: WebClient): void {
  queue.process("ops-task", async (task) => {
    const post = (text: string) =>
      slack.chat.postMessage({ channel: task.channel, thread_ts: task.threadTs, text });

    const cardKey = `${task.threadKey}:ops-${task.discipline}`;
    const checks = await preflightOrAbort(
      task.discipline,
      { cardKey, title: task.title, agent: opsSpecialistName(task.discipline), squad: "operacoes" },
      post,
    );
    if (!checks) return;
    try {
      track(
        cardKey,
        { title: task.title, agent: opsSpecialistName(task.discipline), squad: "operacoes", column: "execucao" },
        "trabalhando na demanda",
      );
      await post(`:briefcase: ${opsSpecialistName(task.discipline)} aqui — peguei *${task.title}*.`);

      const model = routeModel(config.models.ops, { text: task.instructions });
      const baseApprove = slackApprover(slack, task.channel, task.threadTs);
      const approve: Approver = async (opts) => {
        track(cardKey, { column: "aprovacao" }, "pediu OK humano para enviar");
        const decision = await baseApprove(opts);
        track(cardKey, { column: "execucao" }, decision.approved ? "envio aprovado" : "envio recusado");
        return decision;
      };
      const specialist = createOpsSpecialistAgent(
        task.discipline,
        { approve, thread: { channel: task.channel, threadTs: task.threadTs, threadKey: task.threadKey, slack } },
        model,
      );

      const initial =
        `Trabalhe na demanda a seguir.\n\nDemanda: ${task.title}\n\n${task.instructions}\n\n` +
        `Lembre: request_send_approval ANTES de qualquer envio.` +
        formatPreflight(checks);

      const { text } = await runAgent(specialist, [{ role: "user", content: initial }]);
      track(cardKey, { column: "concluido", outcome: "ok" }, "demanda concluída");
      if (text) await post(text);
    } catch (err) {
      track(cardKey, { column: "concluido", outcome: "falha" }, "erro na demanda");
      console.error("Erro no worker de operações:", err);
      await post(`Tive um problema na demanda: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

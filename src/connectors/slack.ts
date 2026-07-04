import bolt from "@slack/bolt";
import type { ModelMessage } from "ai";
import { config } from "../config.js";
import type { Agent } from "../agents/types.js";
import type { AgentContext } from "../agents/context.js";
import type { ThreadMemory } from "../memory/thread-memory.js";
import { runAgent } from "../agent-runtime/run.js";
import { registerApprovalHandlers } from "../approvals/gate.js";
import { answerQuestion } from "../approvals/questions.js";
import { track, listBoard } from "../board/board.js";
import { resolveAgentMention } from "./routing.js";
import { specialistName } from "../agents/marketing-specialist.js";
import { queue } from "../queue/index.js";

const { App } = bolt;

/** Remove a menção ao bot (<@U123>) do texto recebido. */
function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

/**
 * Cria o app do Slack. Recebe uma FÁBRICA de agente (construída por menção, com o
 * contexto da thread) — assim as ferramentas (delegar, aprovar) sabem onde operar.
 */
export function createSlackApp(
  agentFactory: (ctx: AgentContext, userText: string) => Agent,
  memory: ThreadMemory,
) {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  registerApprovalHandlers(app);

  app.event("app_mention", async ({ event, client }) => {
    const channel = event.channel;
    const threadTs = event.thread_ts ?? event.ts;
    const threadKey = `${channel}:${threadTs}`;
    const userText = stripMention(event.text ?? "");
    if (!userText) return;

    try {
      await client.reactions.add({ channel, timestamp: event.ts, name: "eyes" });
    } catch {
      /* reação é best-effort */
    }

    // 1) Havia uma pergunta de agente esperando nesta thread? A menção é a RESPOSTA.
    if (answerQuestion(threadKey, userText, `slack:${event.user ?? "?"}`)) {
      try {
        await client.reactions.add({ channel, timestamp: event.ts, name: "white_check_mark" });
      } catch {
        /* reação é best-effort */
      }
      return;
    }

    // 2) Mensagem endereçada a alguém do squad de marketing ("Sofia, troca o tom...")
    //    vai DIRETO para a pessoa certa, com o contexto da frente existente na thread.
    const routed = resolveAgentMention(userText);
    if (routed && routed.kind !== "pm") {
      const suffix = routed.kind === "lead" ? "marketing-lead" : `mkt-${routed.discipline}`;
      const cardKey = `${threadKey}:${suffix}`;
      const existing = listBoard().find((c) => c.key === cardKey);
      const title = existing?.title ?? userText.slice(0, 80);
      const instructions = existing
        ? `Ajuste solicitado na thread sobre o trabalho anterior ("${existing.title}"). ` +
          `Procure o material existente no Notion antes de refazer do zero.\n\nPedido: ${userText}`
        : userText;

      await memory.append(threadKey, { role: "user", content: userText });
      if (routed.kind === "lead") {
        track(cardKey, { title, agent: "Malu (Head de Marketing)", squad: "marketing", column: "fila" }, "follow-up na thread");
        await queue.enqueue("marketing-task", { channel, threadTs, threadKey, brief: { title }, instructions });
      } else {
        track(
          cardKey,
          { title, agent: specialistName(routed.discipline), squad: "marketing", column: "fila" },
          "follow-up na thread",
        );
        await queue.enqueue("marketing-work", {
          channel,
          threadTs,
          threadKey,
          discipline: routed.discipline,
          brief: { title },
          instructions,
        });
      }
      return;
    }

    // 3) Fluxo normal: Ana (PM), com a memória da thread.
    const cardKey = `${threadKey}:pm`;
    try {
      const agent = agentFactory({ channel, threadTs, threadKey, slack: client }, userText);
      track(
        cardKey,
        { title: userText.slice(0, 80), agent: agent.name, squad: "produto", column: "execucao" },
        "menção recebida no Slack",
      );
      await memory.append(threadKey, { role: "user", content: userText });
      const { text, newMessages } = await runAgent(agent, await memory.get(threadKey));
      await memory.append(threadKey, ...(newMessages as ModelMessage[]));

      track(cardKey, { column: "concluido", outcome: "ok" }, "respondeu na thread");
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: text || "(sem resposta)",
      });
    } catch (err) {
      track(cardKey, { column: "concluido", outcome: "falha" }, "erro ao processar a menção");
      console.error("Erro ao processar menção:", err);
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Ops, tive um problema ao processar isso: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  });

  return app;
}

import bolt from "@slack/bolt";
import { config } from "../config.js";
import type { Agent } from "../agents/types.js";
import type { AgentContext } from "../agents/context.js";
import type { ThreadMemory } from "../memory/thread-memory.js";
import { registerApprovalHandlers } from "../approvals/gate.js";
import { SlackMessenger } from "../messaging/messenger.js";
import { dispatchMention } from "./dispatch.js";

const { App } = bolt;

/** Remove a menção ao bot (<@U123>) do texto recebido. */
function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

/**
 * Cria o app do Slack. Recebe uma FÁBRICA de agente (construída por menção, com o
 * contexto da thread) — assim as ferramentas (delegar, aprovar) sabem onde operar.
 * O pipeline de menção em si vive em dispatch.ts (compartilhado com o chat do painel).
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
  const messenger = new SlackMessenger(app.client, config.slack.defaultChannel);

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

    const result = await dispatchMention(
      userText,
      { channel, threadTs, threadKey },
      { messenger, agentFactory, memory, actor: `slack:${event.user ?? "?"}` },
    );

    if (result === "answered") {
      try {
        await client.reactions.add({ channel, timestamp: event.ts, name: "white_check_mark" });
      } catch {
        /* reação é best-effort */
      }
    }
  });

  return { app, messenger };
}

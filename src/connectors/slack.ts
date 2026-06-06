import bolt from "@slack/bolt";
import type { ModelMessage } from "ai";
import { config } from "../config.js";
import type { Agent } from "../agents/types.js";
import type { ThreadMemory } from "../memory/thread-memory.js";
import { runAgent } from "../agent-runtime/run.js";

const { App } = bolt;

/** Remove a menção ao bot (<@U123>) do texto recebido. */
function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

/**
 * Cria o app do Slack que dá "vida" ao agente: ele escuta menções (@Ana) e responde
 * na própria thread, mantendo a memória da conversa. É a UI primária do dream team.
 */
export function createSlackApp(agent: Agent, memory: ThreadMemory) {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  app.event("app_mention", async ({ event, client }) => {
    const channel = event.channel;
    const threadTs = event.thread_ts ?? event.ts;
    const threadKey = `${channel}:${threadTs}`;
    const userText = stripMention(event.text ?? "");
    if (!userText) return;

    // Feedback imediato de "estou olhando".
    try {
      await client.reactions.add({ channel, timestamp: event.ts, name: "eyes" });
    } catch {
      /* reação é best-effort */
    }

    try {
      memory.append(threadKey, { role: "user", content: userText });
      const { text, newMessages } = await runAgent(agent, memory.get(threadKey));
      memory.append(threadKey, ...(newMessages as ModelMessage[]));

      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: text || "(sem resposta)",
      });
    } catch (err) {
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

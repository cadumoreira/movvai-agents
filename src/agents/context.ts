import type { Messenger } from "../messaging/messenger.js";

/**
 * Contexto da conversa em que um agente está agindo. Permite que as ferramentas
 * (delegar, pedir aprovação, responder) saibam em qual thread operar — e por qual
 * canal falar (Slack ou painel), via Messenger.
 */
export interface AgentContext {
  channel: string;
  threadTs: string;
  threadKey: string;
  messenger: Messenger;
}

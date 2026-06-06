import type { WebClient } from "@slack/web-api";

/**
 * Contexto da conversa em que um agente está agindo. Permite que as ferramentas
 * (delegar, pedir aprovação, responder) saibam em qual thread do Slack operar.
 */
export interface AgentContext {
  channel: string;
  threadTs: string;
  threadKey: string;
  slack: WebClient;
}

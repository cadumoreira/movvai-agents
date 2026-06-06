import { randomUUID } from "node:crypto";
import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

export interface ApprovalDecision {
  approved: boolean;
  feedback?: string;
}

/**
 * Abstração de aprovação: o agente pede um OK e recebe a decisão, sem saber se veio
 * do Slack (produção) ou do terminal (smoke test). Permite testar local sem Slack.
 */
export type Approver = (opts: { text: string }) => Promise<ApprovalDecision>

/** Aprovação via Slack (botões), amarrada a uma thread. */
export function slackApprover(client: WebClient, channel: string, threadTs: string): Approver {
  return ({ text }) => requestApproval(client, { channel, threadTs, text });
}

interface PendingApproval {
  resolve: (d: ApprovalDecision) => void;
}

/**
 * Portão de aprovação: posta uma mensagem no Slack com botões e PAUSA até o humano
 * decidir. É a "interrupção durável" da arquitetura — o agente só age em pontos-chave
 * (abrir PR) depois do seu OK.
 *
 * MVP: estado em memória (Map). Em produção, persistir o pendente (Redis/DB) para
 * sobreviver a restart enquanto espera a decisão.
 */
const pending = new Map<string, PendingApproval>();

export async function requestApproval(
  client: WebClient,
  opts: { channel: string; threadTs: string; text: string },
): Promise<ApprovalDecision> {
  const id = randomUUID();

  await client.chat.postMessage({
    channel: opts.channel,
    thread_ts: opts.threadTs,
    text: opts.text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: opts.text } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✅ Aprovar" },
            style: "primary",
            action_id: "pr_decision:approve",
            value: id,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "❌ Recusar" },
            style: "danger",
            action_id: "pr_decision:reject",
            value: id,
          },
        ],
      },
    ],
  });

  return new Promise<ApprovalDecision>((resolve) => {
    pending.set(id, { resolve });
  });
}

/** Registra o handler dos botões de aprovação no app do Slack. */
export function registerApprovalHandlers(app: App): void {
  app.action(/^pr_decision:(approve|reject)$/, async ({ ack, action, body, client }) => {
    await ack();

    // action é um ButtonAction; body é um BlockAction. Acesso pontual via any
    // para evitar verbosidade de tipos do Bolt.
    const a = action as { action_id: string; value?: string };
    const decision = a.action_id.endsWith("approve") ? "approve" : "reject";
    const id = a.value ?? "";

    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      entry.resolve({ approved: decision === "approve" });
    }

    // Atualiza a mensagem para registrar quem decidiu o quê.
    const b = body as { channel?: { id: string }; message?: { ts: string }; user?: { id: string } };
    if (b.channel && b.message) {
      const label = decision === "approve" ? "✅ Aprovado" : "❌ Recusado";
      await client.chat.update({
        channel: b.channel.id,
        ts: b.message.ts,
        text: `${label} por <@${b.user?.id ?? "?"}>`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `${label} por <@${b.user?.id ?? "?"}>` },
          },
        ],
      });
    }
  });
}

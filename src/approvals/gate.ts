import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { register, resolvePending, unregister, type ApprovalDecision } from "./registry.js";
import { canApprove } from "../auth/rbac.js";

export type { ApprovalDecision } from "./registry.js";

/**
 * Abstração de aprovação: o agente pede um OK e recebe a decisão, sem saber se veio
 * do Slack (produção) ou do terminal (smoke test). Permite testar local sem Slack.
 */
export type Approver = (opts: { text: string }) => Promise<ApprovalDecision>;

/** Aprovação via Slack (botões), amarrada a uma thread. */
export function slackApprover(client: WebClient, channel: string, threadTs: string): Approver {
  return ({ text }) => requestApproval(client, { channel, threadTs, text });
}

/**
 * Portão de aprovação: registra a pendência no registro central, posta uma mensagem no
 * Slack com botões e PAUSA até o humano decidir (no Slack OU no painel web). É a
 * "interrupção durável" — o agente só age em pontos-chave (abrir PR) depois do seu OK.
 */
export async function requestApproval(
  client: WebClient,
  opts: { channel: string; threadTs: string; text: string },
): Promise<ApprovalDecision> {
  const { id, promise } = register(opts.text, `${opts.channel}:${opts.threadTs}`);

  try {
    await postApprovalButtons(client, opts, id);
  } catch (err) {
    // Sem botões não há como decidir — remove a pendência para não virar
    // fantasma no painel (e alvo eterno dos lembretes).
    unregister(id);
    throw err;
  }

  return promise;
}

async function postApprovalButtons(
  client: WebClient,
  opts: { channel: string; threadTs: string; text: string },
  id: string,
): Promise<void> {
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
}

/** Registra o handler dos botões de aprovação no app do Slack. */
export function registerApprovalHandlers(app: App): void {
  app.action(/^pr_decision:(approve|reject)$/, async ({ ack, action, body, client }) => {
    await ack();

    const a = action as { action_id: string; value?: string };
    const decision = a.action_id.endsWith("approve") ? "approve" : "reject";
    const b = body as { channel?: { id: string }; message?: { ts: string }; user?: { id: string } };
    const userId = b.user?.id ?? "?";

    // RBAC: só aprovadores autorizados decidem.
    if (!canApprove(userId)) {
      if (b.channel) {
        await client.chat.postEphemeral({
          channel: b.channel.id,
          user: userId,
          text: "Você não tem permissão para aprovar esta ação.",
        });
      }
      return;
    }

    const applied = resolvePending(a.value ?? "", { approved: decision === "approve" }, `slack:${userId}`);

    // Já decidido (outro clique/painel chegou antes)? Não reescreve o desfecho real.
    if (!applied) {
      if (b.channel) {
        await client.chat.postEphemeral({
          channel: b.channel.id,
          user: userId,
          text: "Essa aprovação já tinha sido decidida (por outro clique ou pelo painel).",
        });
      }
      return;
    }

    // Atualiza a mensagem para registrar quem decidiu o quê.
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

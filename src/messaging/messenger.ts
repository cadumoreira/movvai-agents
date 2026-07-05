import { randomUUID } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { register, type ApprovalDecision } from "../approvals/registry.js";
import { requestApproval, type Approver } from "../approvals/gate.js";
import { appendMessage } from "./conversations.js";

/**
 * Abstração de mensageria: como o time FALA e PEDE APROVAÇÃO, sem saber se o canal
 * é o Slack, o painel web ou (no futuro) e-mail/WhatsApp. Toda mensagem também é
 * gravada na thread interna (conversations), então o painel sempre mostra a conversa.
 *
 * - SlackMessenger: posta no Slack (com botões de aprovação) + grava internamente.
 * - PanelMessenger: só a thread interna; a aprovação/resposta acontece no painel.
 */
export interface ThreadTarget {
  channel: string;
  threadTs: string;
  threadKey: string;
}

export interface Messenger {
  /** Posta uma mensagem do agente `from` no thread. */
  post(target: { channel: string; threadTs: string }, text: string, from?: string): Promise<void>;
  /**
   * Abre um NOVO thread para uma demanda/rotina e posta a mensagem-âncora. No Slack,
   * cria uma thread real no canal (para que a equipe veja e responda por lá); no painel,
   * cunha um id interno. Retorna null se não há como ancorar (Slack sem canal).
   */
  openThread(anchorText: string, opts?: { channel?: string }): Promise<ThreadTarget | null>;
  /** Aprovação amarrada a um thread (Slack: botões; painel: decide na web). */
  approver(target: ThreadTarget): Approver;
  /** Reação best-effort a uma mensagem (só faz sentido no Slack). */
  react?(channel: string, ts: string, name: string): Promise<void>;
  /** Canal de origem deste messenger. */
  readonly kind: "slack" | "panel" | "console";
}

/** threadKey é sempre `${channel}:${threadTs}` — invariante do sistema. */
function keyOf(target: { channel: string; threadTs: string }): string {
  return `${target.channel}:${target.threadTs}`;
}

/** Cunha um thread interno (sem Slack): canal fixo + id aleatório. */
export function internalThread(channel: string): ThreadTarget {
  const threadTs = randomUUID();
  return { channel, threadTs, threadKey: `${channel}:${threadTs}` };
}

export class SlackMessenger implements Messenger {
  readonly kind = "slack" as const;
  constructor(
    private readonly client: WebClient,
    private readonly defaultChannel: string,
  ) {}

  async post(target: { channel: string; threadTs: string }, text: string, from = "sistema"): Promise<void> {
    appendMessage(keyOf(target), from, text);
    await this.client.chat.postMessage({ channel: target.channel, thread_ts: target.threadTs, text });
  }

  async openThread(anchorText: string, opts?: { channel?: string }): Promise<ThreadTarget | null> {
    const channel = opts?.channel || this.defaultChannel;
    if (!channel) return null;
    const posted = await this.client.chat.postMessage({ channel, text: anchorText });
    const threadTs = String(posted.ts);
    const target = { channel, threadTs, threadKey: `${channel}:${threadTs}` };
    appendMessage(target.threadKey, "sistema", anchorText);
    return target;
  }

  approver(target: ThreadTarget): Approver {
    return async ({ text }) => {
      appendMessage(target.threadKey, "sistema", text);
      return requestApproval(this.client, { channel: target.channel, threadTs: target.threadTs, text });
    };
  }

  async react(channel: string, ts: string, name: string): Promise<void> {
    await this.client.reactions.add({ channel, timestamp: ts, name }).catch(() => undefined);
  }
}

export class PanelMessenger implements Messenger {
  readonly kind = "panel" as const;

  async post(target: { channel: string; threadTs: string }, text: string, from = "sistema"): Promise<void> {
    appendMessage(keyOf(target), from, text);
  }

  async openThread(anchorText: string): Promise<ThreadTarget> {
    const target = internalThread("painel");
    appendMessage(target.threadKey, "sistema", anchorText);
    return target;
  }

  approver(target: ThreadTarget): Approver {
    return async ({ text }): Promise<ApprovalDecision> => {
      const { promise } = register(text, target.threadKey);
      appendMessage(target.threadKey, "sistema", `:hourglass: Aprovação pendente — decida no painel:\n${text}`);
      return promise;
    };
  }
}

/** Para scripts/CLI: imprime no console e grava na thread interna. */
export class ConsoleMessenger implements Messenger {
  readonly kind = "console" as const;
  constructor(private readonly approve: Approver) {}

  async post(target: { channel: string; threadTs: string }, text: string, from = "agente"): Promise<void> {
    appendMessage(keyOf(target), from, text);
    console.log(`\n[${from}] ${text}\n`);
  }

  async openThread(anchorText: string): Promise<ThreadTarget> {
    const target = internalThread("cli");
    appendMessage(target.threadKey, "sistema", anchorText);
    console.log(`\n[sistema] ${anchorText}\n`);
    return target;
  }

  approver(): Approver {
    return this.approve;
  }
}

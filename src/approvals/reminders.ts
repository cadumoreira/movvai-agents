import type { WebClient } from "@slack/web-api";
import { listPending } from "./registry.js";
import { listQuestions } from "./questions.js";
import { config } from "../config.js";

/**
 * Lembrete de pendências HUMANAS: o gargalo do time autônomo é a latência da SUA
 * decisão. Aprovação/pergunta parada além de APPROVAL_REMINDER_MINUTES ganha um
 * lembrete na própria thread — e re-lembrete no mesmo intervalo, até ser decidida.
 * 100% determinístico (zero tokens).
 */

export interface PendingItem {
  id: string;
  kind: "aprovacao" | "pergunta";
  threadKey?: string;
  createdAt: string;
  summary: string;
}

/** Está na hora de (re)lembrar? Pura e testável. */
export function dueForReminder(
  createdAt: string,
  lastRemindedAt: number | undefined,
  now: number,
  intervalMs: number,
): boolean {
  if (intervalMs <= 0) return false;
  const anchor = lastRemindedAt ?? Date.parse(createdAt);
  return Number.isFinite(anchor) && now - anchor >= intervalMs;
}

/** Snapshot unificado das pendências humanas (aprovações + perguntas). */
export function pendingItems(): PendingItem[] {
  return [
    ...listPending().map((a) => ({
      id: `ap:${a.id}`,
      kind: "aprovacao" as const,
      threadKey: a.threadKey,
      createdAt: a.createdAt,
      summary: a.text.split("\n")[0].slice(0, 120),
    })),
    // id estável por createdAt (índice do FIFO muda quando outra pergunta é respondida)
    ...listQuestions().map((q) => ({
      id: `q:${q.threadKey}:${q.createdAt}`,
      kind: "pergunta" as const,
      threadKey: q.threadKey,
      createdAt: q.createdAt,
      summary: `${q.askedBy}: ${q.question.slice(0, 120)}`,
    })),
  ];
}

/** threadKey "canal:ts" → destino no Slack. */
export function splitThreadKey(threadKey: string): { channel: string; threadTs: string } | null {
  const i = threadKey.indexOf(":");
  if (i <= 0 || i === threadKey.length - 1) return null;
  return { channel: threadKey.slice(0, i), threadTs: threadKey.slice(i + 1) };
}

/** Liga o loop de lembretes (no-op com APPROVAL_REMINDER_MINUTES=0). */
export function startReminders(slack: WebClient): void {
  const intervalMs = config.jobs.approvalReminderMinutes * 60_000;
  if (intervalMs <= 0) return;

  const reminded = new Map<string, number>();
  const tick = async () => {
    const now = Date.now();
    const items = pendingItems();

    // Higiene: esquece o que já foi decidido.
    const alive = new Set(items.map((i) => i.id));
    for (const key of reminded.keys()) if (!alive.has(key)) reminded.delete(key);

    for (const item of items) {
      if (!item.threadKey || !dueForReminder(item.createdAt, reminded.get(item.id), now, intervalMs)) continue;
      const dest = splitThreadKey(item.threadKey);
      if (!dest) continue;
      reminded.set(item.id, now);
      const waitingMin = Math.round((now - Date.parse(item.createdAt)) / 60_000);
      await slack.chat
        .postMessage({
          channel: dest.channel,
          thread_ts: dest.threadTs,
          text: `:hourglass_flowing_sand: Lembrete: ${item.kind === "aprovacao" ? "aprovação" : "pergunta"} esperando você há ~${waitingMin}min — ${item.summary}`,
        })
        .catch(() => undefined); // lembrete é best-effort
    }
  };

  setInterval(() => void tick(), 60_000);
  console.log(
    JSON.stringify({ level: "info", kind: "reminders", everyMinutes: config.jobs.approvalReminderMinutes, at: new Date().toISOString() }),
  );
}

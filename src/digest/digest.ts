import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { listBoard } from "../board/board.js";
import { listPending } from "../approvals/registry.js";
import { listQuestions } from "../approvals/questions.js";
import { billingSummary } from "../billing/meter.js";
import { listPublications } from "../publish/publishers.js";

/**
 * O time que INFORMA: o "bom-dia" é 100% determinístico (board + aprovações +
 * perguntas + custo + publicações) — zero tokens. O mesmo coletor vira a ferramenta
 * team_stats para a Malu/Nina montarem o relatório mensal com números reais.
 */

export interface DigestData {
  doneLast24h: Array<{ agent: string; title: string; outcome?: string; squad: string }>;
  inProgress: Array<{ agent: string; title: string; squad: string }>;
  awaitingHuman: { approvals: string[]; questions: string[] };
  billing: ReturnType<typeof billingSummary>;
  publications: ReturnType<typeof listPublications>;
}

export function collectDigest(now = Date.now()): DigestData {
  const cards = listBoard();
  const dayAgo = now - 24 * 3600_000;
  return {
    doneLast24h: cards
      .filter((c) => c.column === "concluido" && Date.parse(c.updatedAt) >= dayAgo)
      .map((c) => ({ agent: c.agent, title: c.title, outcome: c.outcome, squad: c.squad })),
    inProgress: cards
      .filter((c) => c.column === "execucao" || c.column === "fila")
      .map((c) => ({ agent: c.agent, title: c.title, squad: c.squad })),
    awaitingHuman: {
      approvals: listPending().map((a) => a.text.split("\n")[0].slice(0, 90)),
      questions: listQuestions().map((q) => `${q.askedBy}: ${q.question.slice(0, 90)}`),
    },
    billing: billingSummary(),
    publications: listPublications(5),
  };
}

/** Formata o bom-dia em mrkdwn do Slack. */
export function formatDigest(d: DigestData): string {
  const lines: string[] = [":sunrise: *Bom-dia do time* — resumo das últimas 24h"];

  lines.push(`\n*Concluídas (24h):* ${d.doneLast24h.length || "nenhuma"}`);
  for (const c of d.doneLast24h.slice(0, 8)) {
    lines.push(`  • ${c.agent} — ${c.title}${c.outcome && c.outcome !== "ok" ? ` (${c.outcome})` : ""}`);
  }

  if (d.inProgress.length) {
    lines.push(`\n*Em andamento:* ${d.inProgress.length}`);
    for (const c of d.inProgress.slice(0, 6)) lines.push(`  • ${c.agent} — ${c.title}`);
  }

  const waiting = d.awaitingHuman.approvals.length + d.awaitingHuman.questions.length;
  lines.push(`\n*Esperando VOCÊ:* ${waiting || "nada"} ${waiting ? ":hourglass_flowing_sand:" : ":white_check_mark:"}`);
  for (const a of d.awaitingHuman.approvals) lines.push(`  • aprovação: ${a}`);
  for (const q of d.awaitingHuman.questions) lines.push(`  • pergunta: ${q}`);

  if (d.publications.length) {
    lines.push(`\n*Publicações recentes:*`);
    for (const p of d.publications) lines.push(`  • [${p.channel}] ${p.title}`);
  }

  const totalCost = d.billing.reduce((s, o) => s + (Number(o.costUSD) || 0), 0);
  if (d.billing.length) lines.push(`\n*Custo acumulado:* $${totalCost.toFixed(2)} (${d.billing.length} org)`);

  return lines.join("\n");
}

/** Números reais do time para relatórios (Malu/Nina) — nada de inventar métrica. */
export function teamStatsTools(): ToolSet {
  return {
    team_stats: tool({
      description:
        "Números REAIS do time agora: frentes concluídas/em andamento, pendências humanas, custo por " +
        "organização e últimas publicações. Use como fonte para relatórios (semanais/mensais) — nunca invente número.",
      inputSchema: z.object({}),
      execute: async () => collectDigest(),
    }),
  };
}

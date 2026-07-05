import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { until } from "./helpers.js";
import {
  runMarketingLeadTask,
  endedNeedingHuman,
  toolNamesUsed,
} from "../src/workers/marketing-lead-worker.js";
import { PanelMessenger } from "../src/messaging/messenger.js";
import { listBoard, resetBoard } from "../src/board/board.js";
import { answerQuestion, resetQuestions, listQuestions } from "../src/approvals/questions.js";

process.env.AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), "audit-mlw-")), "audit.log");

beforeEach(() => {
  resetBoard();
  resetQuestions();
});

// ── Ferramenta pura de decisão ──────────────────────────────────────────────

const textTurn = (text: string): ModelMessage[] => [{ role: "assistant", content: [{ type: "text", text }] }];
const toolTurn = (toolName: string): ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName, input: {} }] as never },
];

test("endedNeedingHuman: pergunta em texto puro (sem agir) precisa do humano", () => {
  assert.equal(endedNeedingHuman("Qual é o público-alvo?", textTurn("Qual é o público-alvo?")), true);
});

test("endedNeedingHuman: turno que delegou NÃO precisa do humano (mesmo com '?')", () => {
  assert.equal(endedNeedingHuman("Deleguei pro Caio. Alguma dúvida?", toolTurn("assign_marketing_work")), false);
});

test("endedNeedingHuman: turno que gravou doc de marca NÃO precisa do humano", () => {
  assert.equal(endedNeedingHuman("Escrevi o brand-book. Confere?", toolTurn("write_brand_doc")), false);
});

test("endedNeedingHuman: ask_clarification já trata a pausa — não conta como órfã", () => {
  assert.equal(endedNeedingHuman("...", toolTurn("ask_clarification")), false);
});

test("endedNeedingHuman: fechamento sem pergunta conclui a frente", () => {
  assert.equal(endedNeedingHuman("Beleza, acionei o squad.", textTurn("Beleza, acionei o squad.")), false);
});

test("toolNamesUsed coleta os nomes das tool-calls e ignora texto", () => {
  const msgs = [...textTurn("oi"), ...toolTurn("assign_marketing_work")];
  assert.deepEqual([...toolNamesUsed(msgs)], ["assign_marketing_work"]);
});

// ── Worker: a entrevista segura a frente e retoma com a resposta ─────────────

// Fake do runtime, ramificado pelo título da demanda (embutido no prompt inicial):
//  · "brandbook" → entrevista: pergunta em texto puro na 1ª rodada; após a resposta
//    entrar no histórico, delega e encerra.
//  · "campanha"  → age de cara: delega já na 1ª rodada, sem segurar o humano.
const scriptedRun = async (_agent: unknown, history: ModelMessage[]) => {
  const initial = String((history[0] as { content?: unknown })?.content ?? "");
  const answered = history.some((m) => m.role === "assistant");
  if (initial.includes("brandbook") && !answered) {
    const q = "Qual é o público-alvo da marca?";
    return { text: q, newMessages: textTurn(q) };
  }
  return { text: "Fechado — montei o brief e acionei o squad.", newMessages: toolTurn("assign_marketing_work") };
};

const fakeDeps = { run: scriptedRun as never, createAgent: (() => ({}) as never) as never };
const taskFor = (threadKey: string, title: string, instructions: string) => ({
  channel: "painel",
  threadTs: threadKey.split(":")[1],
  threadKey,
  brief: { title },
  instructions,
});

test("worker: pergunta em texto puro segura a frente em 'Aguardando humano' (não conclui)", async () => {
  const threadKey = "painel:brand-1";
  const cardKey = `${threadKey}:marketing-lead`;
  // Dispara o job SEM esperar: a Malu pergunta e pausa aguardando o humano.
  const done = runMarketingLeadTask(taskFor(threadKey, "criar brandbook", "me ajude a criar um brandbook"), new PanelMessenger(), fakeDeps);

  // BUG ANTIGO: a frente ia direto para concluido/ok "frentes acionadas" e nenhuma
  // pergunta ficava pendente — a resposta do humano vazava para a PM.
  await until(() => listBoard().some((c) => c.key === cardKey && c.column === "aprovacao"));
  const card = listBoard().find((c) => c.key === cardKey)!;
  assert.equal(card.column, "aprovacao", "frente deve esperar o humano, não concluir");
  assert.notEqual(card.outcome, "ok");
  assert.equal(listQuestions().filter((q) => q.threadKey === threadKey).length, 1, "deve haver 1 pergunta pendente");

  // A resposta na thread retoma a MESMA frente (com contexto) e agora ela conclui.
  assert.equal(answerQuestion(threadKey, "PMEs de tech no Brasil", "painel"), true);
  await done;
  const finished = listBoard().find((c) => c.key === cardKey)!;
  assert.equal(finished.column, "concluido");
  assert.equal(finished.outcome, "ok");
  assert.equal(finished.notes.at(-1)?.text, "brief pronto e frentes acionadas");
  assert.equal(listQuestions().filter((q) => q.threadKey === threadKey).length, 0);
});

test("worker: demanda que já delega de cara conclui sem segurar o humano", async () => {
  const threadKey = "painel:campanha-1";
  const cardKey = `${threadKey}:marketing-lead`;
  await runMarketingLeadTask(taskFor(threadKey, "campanha de lançamento", "divulgue o plano Pro"), new PanelMessenger(), fakeDeps);

  const done = listBoard().find((c) => c.key === cardKey)!;
  assert.equal(done.column, "concluido");
  assert.equal(done.outcome, "ok");
  assert.equal(done.notes.at(-1)?.text, "brief pronto e frentes acionadas");
  // Não deve ter segurado o humano em nenhum momento.
  assert.equal(listQuestions().filter((q) => q.threadKey === threadKey).length, 0);
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { until } from "./helpers.js";
import { runOpsTask, endedNeedingHuman, toolNamesUsed } from "../src/workers/ops-worker.js";
import { PanelMessenger } from "../src/messaging/messenger.js";
import { listBoard, resetBoard } from "../src/board/board.js";
import { answerQuestion, resetQuestions, listQuestions } from "../src/approvals/questions.js";

process.env.AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), "audit-ops-")), "audit.log");

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
  assert.equal(endedNeedingHuman("Qual é o valor em aberto?", textTurn("Qual é o valor em aberto?")), true);
});

test("endedNeedingHuman: turno que pediu aprovação de envio NÃO precisa do humano (mesmo com '?')", () => {
  assert.equal(endedNeedingHuman("Mandei pra aprovação. Pode olhar?", toolTurn("request_send_approval")), false);
});

test("endedNeedingHuman: ask_clarification já trata a pausa — não conta como órfã", () => {
  assert.equal(endedNeedingHuman("...", toolTurn("ask_clarification")), false);
});

test("endedNeedingHuman: fechamento sem pergunta conclui a demanda", () => {
  assert.equal(endedNeedingHuman("Pronto, enviei o resumo na thread.", textTurn("Pronto, enviei o resumo na thread.")), false);
});

test("toolNamesUsed coleta os nomes das tool-calls e ignora texto", () => {
  const msgs = [...textTurn("oi"), ...toolTurn("request_send_approval")];
  assert.deepEqual([...toolNamesUsed(msgs)], ["request_send_approval"]);
});

// ── Worker: a pergunta em texto segura a demanda e retoma com a resposta ──────

// Fake do runtime, ramificado pelo título da demanda (embutido no prompt inicial):
//  · "cobranca" → pergunta em texto puro na 1ª rodada (sem agir); após a resposta
//    entrar no histórico, pede aprovação de envio e encerra.
//  · "prospect" → age de cara: pede aprovação já na 1ª rodada, sem segurar o humano.
const scriptedRun = async (_agent: unknown, history: ModelMessage[]) => {
  const initial = String((history[0] as { content?: unknown })?.content ?? "");
  const answered = history.some((m) => m.role === "assistant");
  if (initial.includes("cobranca") && !answered) {
    const q = "Qual é o valor e o vencimento em aberto?";
    return { text: q, newMessages: textTurn(q) };
  }
  return { text: "Rascunho pronto e enviado para aprovação.", newMessages: toolTurn("request_send_approval") };
};

const fakeDeps = { run: scriptedRun as never, createAgent: (() => ({}) as never) as never };
const taskFor = (threadKey: string, discipline: "sdr" | "suporte" | "financeiro", title: string, instructions: string) => ({
  channel: "painel",
  threadTs: threadKey.split(":")[1],
  threadKey,
  discipline,
  title,
  instructions,
});

test("worker: pergunta em texto puro segura a demanda em 'Aguardando humano' (não conclui)", async () => {
  const threadKey = "painel:cob-1";
  const cardKey = `${threadKey}:ops-financeiro`;
  // Dispara o job SEM esperar: o Otto pergunta e pausa aguardando o humano.
  const done = runOpsTask(taskFor(threadKey, "financeiro", "cobranca do plano Pro", "cobre o cliente atrasado"), new PanelMessenger(), fakeDeps);

  // BUG ANTIGO: a demanda ia direto para concluido/ok e nenhuma pergunta ficava
  // pendente — a resposta do humano vazava para a PM.
  await until(() => listBoard().some((c) => c.key === cardKey && c.column === "aprovacao"));
  const card = listBoard().find((c) => c.key === cardKey)!;
  assert.equal(card.column, "aprovacao", "demanda deve esperar o humano, não concluir");
  assert.notEqual(card.outcome, "ok");
  assert.equal(listQuestions().filter((q) => q.threadKey === threadKey).length, 1, "deve haver 1 pergunta pendente");

  // A resposta na thread retoma a MESMA demanda (com contexto) e agora ela conclui.
  assert.equal(answerQuestion(threadKey, "R$ 1.200, venceu dia 10", "painel"), true);
  await done;
  const finished = listBoard().find((c) => c.key === cardKey)!;
  assert.equal(finished.column, "concluido");
  assert.equal(finished.outcome, "ok");
  assert.equal(listQuestions().filter((q) => q.threadKey === threadKey).length, 0);
});

test("worker: demanda que já age de cara conclui sem segurar o humano", async () => {
  const threadKey = "painel:pros-1";
  const cardKey = `${threadKey}:ops-sdr`;
  await runOpsTask(taskFor(threadKey, "sdr", "prospect novo", "escreva o primeiro contato"), new PanelMessenger(), fakeDeps);

  const done = listBoard().find((c) => c.key === cardKey)!;
  assert.equal(done.column, "concluido");
  assert.equal(done.outcome, "ok");
  // Não deve ter segurado o humano em nenhum momento.
  assert.equal(listQuestions().filter((q) => q.threadKey === threadKey).length, 0);
});

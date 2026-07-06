import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { until } from "./helpers.js";
import { runMarketingWork, endedNeedingHuman } from "../src/workers/marketing-worker.js";
import { PanelMessenger } from "../src/messaging/messenger.js";
import { track, listBoard, resetBoard } from "../src/board/board.js";
import { answerQuestion, resetQuestions, listQuestions } from "../src/approvals/questions.js";

process.env.AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), "audit-mw-")), "audit.log");

beforeEach(() => {
  resetBoard();
  resetQuestions();
});

const textTurn = (text: string): ModelMessage[] => [{ role: "assistant", content: [{ type: "text", text }] }];
const toolTurn = (toolName: string): ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName, input: {} }] as never },
];

test("endedNeedingHuman: pergunta em texto puro precisa do humano", () => {
  assert.equal(endedNeedingHuman("Qual o tom do post?", textTurn("Qual o tom do post?")), true);
});
test("endedNeedingHuman: registrou no Notion não precisa do humano", () => {
  assert.equal(endedNeedingHuman("Feito, alguma dúvida?", toolTurn("notion_create_page")), false);
});
test("endedNeedingHuman: pediu aprovação de publicação não precisa do humano", () => {
  assert.equal(endedNeedingHuman("Aprova?", toolTurn("request_publish_approval")), false);
});

const fakeDeps = {
  run: (async (_a: unknown, history: ModelMessage[]) => {
    const initial = String((history[0] as { content?: unknown })?.content ?? "");
    const answered = history.some((m) => m.role === "assistant");
    if (initial.includes("ENTREVISTA") && !answered) {
      const q = "Qual é o público-alvo do conteúdo?";
      return { text: q, newMessages: textTurn(q) };
    }
    return { text: "Entregável no Notion. Aprova?", newMessages: toolTurn("notion_create_page") };
  }) as never,
  createAgent: (() => ({}) as never) as never,
};

const taskFor = (threadKey: string, instructions: string) => ({
  channel: "painel",
  threadTs: threadKey.split(":")[1],
  threadKey,
  discipline: "conteudo" as const,
  brief: { title: "post de lançamento" },
  instructions,
});

test("worker: especialista que pergunta em texto segura a frente (não conclui) e retoma", async () => {
  const threadKey = "painel:mw-1";
  const cardKey = `${threadKey}:mkt-conteudo`;
  const done = runMarketingWork(taskFor(threadKey, "ENTREVISTA: descubra o tom"), new PanelMessenger(), fakeDeps);

  await until(() => listBoard().some((c) => c.key === cardKey && c.column === "aprovacao"));
  const card = listBoard().find((c) => c.key === cardKey)!;
  assert.equal(card.column, "aprovacao", "frente espera o humano — não vaza pra PM");
  assert.equal(listQuestions().filter((q) => q.threadKey === threadKey).length, 1);

  assert.equal(answerQuestion(threadKey, "PMEs de tech", "painel"), true);
  await done;
  const finished = listBoard().find((c) => c.key === cardKey)!;
  assert.equal(finished.column, "concluido");
  assert.equal(finished.outcome, "ok");
  assert.equal(finished.deliverable?.kind, "notion", "fecha ok apontando pro entregável real");
});

test("worker: estoura o teto ainda perguntando → FALHA (não finge concluído)", async () => {
  const threadKey = "painel:mw-cap";
  const cardKey = `${threadKey}:mkt-conteudo`;
  const alwaysAsk = {
    run: (async () => ({ text: "e agora, qual o tom?", newMessages: textTurn("e agora, qual o tom?") })) as never,
    createAgent: (() => ({}) as never) as never,
  };
  const done = runMarketingWork(taskFor(threadKey, "produza"), new PanelMessenger(), alwaysAsk);
  // Responde sempre que houver pergunta pendente; o teto de rodadas encerra sozinho.
  for (let i = 0; i < 40; i++) {
    const card = listBoard().find((c) => c.key === cardKey);
    if (card?.column === "concluido") break;
    if (listQuestions().some((q) => q.threadKey === threadKey)) answerQuestion(threadKey, "sei lá", "painel");
    await new Promise((r) => setTimeout(r, 15));
  }
  await done;
  const c = listBoard().find((x) => x.key === cardKey)!;
  assert.equal(c.column, "concluido");
  assert.equal(c.outcome, "falha", "estourar rounds ainda perguntando é falha honesta, não ok");
});

test("worker: terminou sem produzir entregável (só texto) → FALHA", async () => {
  const threadKey = "painel:mw-none";
  const cardKey = `${threadKey}:mkt-conteudo`;
  const noProduce = {
    run: (async () => ({ text: "Beleza, feito!", newMessages: textTurn("Beleza, feito!") })) as never,
    createAgent: (() => ({}) as never) as never,
  };
  await runMarketingWork(taskFor(threadKey, "produza"), new PanelMessenger(), noProduce);
  assert.equal(listBoard().find((x) => x.key === cardKey)!.outcome, "falha");
});

test("worker: documento anexado (create_document) conta como entrega → ok", async () => {
  const threadKey = "painel:mw-doc";
  const cardKey = `${threadKey}:mkt-conteudo`;
  const docDeps = {
    run: (async () => {
      track(cardKey, { deliverable: { kind: "doc", summary: "artigo.doc", url: "/artifacts/x" } }, "anexou");
      return { text: "documento anexado, veja o link", newMessages: textTurn("documento anexado") };
    }) as never,
    createAgent: (() => ({}) as never) as never,
  };
  await runMarketingWork(taskFor(threadKey, "produza"), new PanelMessenger(), docDeps);
  const c = listBoard().find((x) => x.key === cardKey)!;
  assert.equal(c.outcome, "ok");
  assert.equal(c.deliverable?.kind, "doc");
});

test("worker: entrega direta fecha ok com deliverable, sem segurar humano", async () => {
  const threadKey = "painel:mw-2";
  const cardKey = `${threadKey}:mkt-conteudo`;
  await runMarketingWork(taskFor(threadKey, "produza logo"), new PanelMessenger(), fakeDeps);
  const c = listBoard().find((x) => x.key === cardKey)!;
  assert.equal(c.column, "concluido");
  assert.equal(c.deliverable?.kind, "notion");
  assert.equal(listQuestions().filter((q) => q.threadKey === threadKey).length, 0);
});

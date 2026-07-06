import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { decomposePlan } from "../src/orchestration/decompose.js";
import { runSubtask } from "../src/workers/subtask-worker.js";
import { PanelMessenger } from "../src/messaging/messenger.js";
import { track, listBoard, boardTree, resetBoard } from "../src/board/board.js";
import { answerQuestion, resetQuestions, listQuestions } from "../src/approvals/questions.js";
import { until } from "./helpers.js";

process.env.AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), "audit-dec-")), "audit.log");

beforeEach(() => {
  resetBoard();
  resetQuestions();
});

const textTurn = (text: string): ModelMessage[] => [{ role: "assistant", content: [{ type: "text", text }] }];
const toolTurn = (toolName: string): ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName, input: {} }] as never },
];

const thread = { channel: "painel", threadTs: "t1", threadKey: "painel:t1" };

/** Executor fake que ENTREGA: simula attach_deliverable gravando no card (como a tool real). */
const attachingDeps = {
  run: (async (agent: { cardKey: string }) => {
    track(agent.cardKey, { deliverable: { kind: "pr", summary: `entrega de ${agent.cardKey}` } }, "anexou");
    return { text: "feito", newMessages: toolTurn("attach_deliverable") };
  }) as never,
  createAgent: ((_ctx: unknown, spec: { cardKey: string }) => ({ cardKey: spec.cardKey }) as never) as never,
};

const jobFor = (cardKey: string, parentKey: string) => ({
  channel: thread.channel,
  threadTs: thread.threadTs,
  threadKey: thread.threadKey,
  parentKey,
  cardKey,
  title: cardKey,
  deliverableGoal: "artefato",
  instructions: "faça",
});

test("decomposePlan cria um card filho por subtarefa, sob o pai, na fila", async () => {
  track("D", { title: "Demanda", agent: "Rui (Tech Lead)", squad: "produto", column: "execucao" }, "");
  const keys = await decomposePlan("D", thread, [
    { title: "Contrato", deliverable: "spec", instructions: "x" },
    { title: "Endpoints", deliverable: "PR", instructions: "y" },
    { title: "Testes", deliverable: "suíte verde", instructions: "z" },
  ]);
  assert.equal(keys.length, 3);
  const kids = listBoard().filter((c) => c.parentKey === "D");
  assert.equal(kids.length, 3);
  assert.ok(kids.every((c) => c.column === "fila"));
  assert.match(kids[0].notes.at(-1)!.text, /entregável esperado/);
});

test("e2e: demanda decomposta → folhas entregam → pai fecha por rollup", async () => {
  track("D", { title: "API + deploy", agent: "Rui (Tech Lead)", squad: "produto", column: "execucao" }, "");
  const keys = await decomposePlan("D", thread, [
    { title: "Contrato", deliverable: "spec", instructions: "x" },
    { title: "Endpoints", deliverable: "PR", instructions: "y" },
  ]);
  // Pai ainda aberto enquanto as folhas não entregam.
  assert.equal(listBoard().find((c) => c.key === "D")!.column, "execucao");

  for (const k of keys) {
    await runSubtask(jobFor(k, "D"), new PanelMessenger(), attachingDeps);
    const leaf = listBoard().find((c) => c.key === k)!;
    assert.equal(leaf.column, "concluido");
    assert.equal(leaf.outcome, "ok");
    assert.ok(leaf.deliverable, "folha fecha com entregável real");
  }

  const parent = listBoard().find((c) => c.key === "D")!;
  assert.equal(parent.column, "concluido", "pai fecha por rollup");
  assert.equal(parent.outcome, "ok");

  const tree = boardTree();
  const root = tree.find((n) => n.key === "D")!;
  assert.equal(root.children.length, 2, "board mostra a árvore");
});

test("honesto: folha que NÃO anexa entregável falha (e derruba o pai)", async () => {
  track("D", { title: "Demanda", column: "execucao" }, "");
  const [k] = await decomposePlan("D", thread, [{ title: "sozinha", deliverable: "algo", instructions: "x" }]);
  const noAttach = {
    run: (async () => ({ text: "terminei sem entregar", newMessages: textTurn("terminei") })) as never,
    createAgent: ((_c: unknown, s: { cardKey: string }) => ({ cardKey: s.cardKey }) as never) as never,
  };
  await runSubtask(jobFor(k, "D"), new PanelMessenger(), noAttach);
  const leaf = listBoard().find((c) => c.key === k)!;
  assert.equal(leaf.outcome, "falha", "sem entregável anexado → falha honesta, não 'finalizado' fantasma");
  assert.equal(listBoard().find((c) => c.key === "D")!.outcome, "falha", "pai bloqueado pela folha que falhou");
});

test("folha que pergunta em texto segura em 'Aguardando humano' e retoma com a resposta", async () => {
  track("D", { title: "Demanda", column: "execucao" }, "");
  const [k] = await decomposePlan("D", thread, [{ title: "s", deliverable: "algo", instructions: "x" }]);
  const askThenAttach = {
    run: (async (agent: { cardKey: string }, history: ModelMessage[]) => {
      const answered = history.filter((m) => m.role === "user").length > 1;
      if (!answered) return { text: "Qual repositório?", newMessages: textTurn("Qual repositório?") };
      track(agent.cardKey, { deliverable: { kind: "pr", summary: "entregue" } }, "anexou");
      return { text: "feito", newMessages: toolTurn("attach_deliverable") };
    }) as never,
    createAgent: ((_c: unknown, s: { cardKey: string }) => ({ cardKey: s.cardKey }) as never) as never,
  };
  const done = runSubtask(jobFor(k, "D"), new PanelMessenger(), askThenAttach);
  await until(() => listBoard().some((c) => c.key === k && c.column === "aprovacao"));
  assert.equal(listQuestions().filter((q) => q.threadKey === thread.threadKey).length, 1);
  assert.equal(answerQuestion(thread.threadKey, "o repo tal", "painel"), true);
  await done;
  assert.equal(listBoard().find((c) => c.key === k)!.outcome, "ok");
  assert.equal(listBoard().find((c) => c.key === "D")!.column, "concluido");
});

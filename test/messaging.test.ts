import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { until } from "./helpers.js";
import {
  appendMessage,
  getConversation,
  hasConversation,
  resetConversations,
  initConversations,
} from "../src/messaging/conversations.js";
import { conversationStore } from "../src/board/store.js";
import { PanelMessenger } from "../src/messaging/messenger.js";
import { dispatchMention } from "../src/connectors/dispatch.js";
import { listPending, resolvePending } from "../src/approvals/registry.js";
import { askQuestion, resetQuestions, listQuestions } from "../src/approvals/questions.js";
import { listBoard, resetBoard, track } from "../src/board/board.js";
import { queue } from "../src/queue/index.js";
import { InMemoryThreadMemory } from "../src/memory/thread-memory.js";

process.env.AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), "audit-msg-")), "audit.log");

beforeEach(() => {
  resetConversations();
  resetBoard();
  resetQuestions();
});

// ── Store de conversas ──────────────────────────────────────────────────────

test("appendMessage grava e getConversation devolve em ordem", () => {
  appendMessage("t1", "Ana (PM)", "oi");
  appendMessage("t1", "você", "e aí", true);
  const msgs = getConversation("t1");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].from, "Ana (PM)");
  assert.equal(msgs[1].human, true);
  assert.equal(hasConversation("t1"), true);
  assert.equal(hasConversation("t2"), false);
});

test("appendMessage ignora entradas vazias", () => {
  appendMessage("", "x", "y");
  appendMessage("t", "x", "");
  assert.equal(getConversation("t").length, 0);
});

test("persistência: sem Redis o store é no-op e initConversations não apaga o que está em memória", async () => {
  // MemoryStore (sem REDIS_URL nos testes): loadAll vazio, save no-op.
  assert.deepEqual(await conversationStore.loadAll(), {});
  appendMessage("t-init", "Ana (PM)", "mensagem viva");
  await initConversations(); // não deve limpar nem lançar
  assert.equal(getConversation("t-init")[0].text, "mensagem viva");
});

// ── PanelMessenger ──────────────────────────────────────────────────────────

test("PanelMessenger.post grava na thread interna (sem Slack)", async () => {
  const m = new PanelMessenger();
  await m.post({ channel: "painel", threadTs: "1" }, "Malu aqui", "Malu (Head de Marketing)");
  const msgs = getConversation("painel:1");
  assert.equal(msgs[0].text, "Malu aqui");
  assert.equal(msgs[0].from, "Malu (Head de Marketing)");
});

test("PanelMessenger.openThread cunha thread interna e posta a âncora", async () => {
  const m = new PanelMessenger();
  const t = await m.openThread(":inbox_tray: demanda X");
  assert.equal(t.channel, "painel");
  assert.equal(t.threadKey, `painel:${t.threadTs}`);
  assert.match(getConversation(t.threadKey)[0].text, /demanda X/);
});

test("PanelMessenger.approver registra no registry e resolve pela web", async () => {
  const m = new PanelMessenger();
  const approve = m.approver({ channel: "painel", threadTs: "9", threadKey: "painel:9" });
  const decisionP = approve({ text: "Publicar peça?" });
  await until(() => listPending().length > 0);
  const pend = listPending()[0];
  assert.equal(pend.threadKey, "painel:9");
  resolvePending(pend.id, { approved: true }, "test");
  assert.deepEqual(await decisionP, { approved: true });
});

// ── dispatchMention (pipeline sem superfície) ───────────────────────────────

const noopMemory = new InMemoryThreadMemory();
const deps = (extra = {}) => ({
  messenger: new PanelMessenger(),
  agentFactory: () => ({ id: "ana", name: "Ana (PM)", system: "", tools: {}, maxSteps: 1 }) as never,
  memory: noopMemory,
  actor: "painel",
  humanLabel: "você",
  ...extra,
});

test("dispatchMention: 'status' responde o digest na thread", async () => {
  const messenger = new PanelMessenger();
  const r = await dispatchMention("status", { channel: "painel", threadTs: "s", threadKey: "painel:s" }, deps({ messenger }));
  assert.equal(r, "status");
  const msgs = getConversation("painel:s");
  // primeira msg é a fala do humano; a última é o digest do "sistema"
  assert.equal(msgs[0].human, true);
  assert.equal(msgs[msgs.length - 1].from, "sistema");
});

test("dispatchMention: nome de agente roteia direto (enfileira o job certo)", async () => {
  const received: string[] = [];
  queue.process("marketing-work", async (d) => void received.push(d.discipline));
  const r = await dispatchMention(
    "Sofia, deixa o post mais curto",
    { channel: "painel", threadTs: "x", threadKey: "painel:x" },
    deps(),
  );
  assert.equal(r, "routed");
  await until(() => received.length > 0);
  assert.equal(received[0], "social");
  assert.ok(listBoard().some((c) => c.key === "painel:x:mkt-social"));
});

test("dispatchMention: DEMANDA NOVA pelo chat (thread sem cards) cria o card da Ana", async () => {
  const r = await dispatchMention(
    "preciso de uma landing page nova",
    { channel: "painel", threadTs: "nova", threadKey: "painel:nova" },
    deps(),
  );
  assert.equal(r, "pm");
  assert.ok(listBoard().some((c) => c.key === "painel:nova:pm"), "demanda nova deve criar o card da Ana");
});

test("dispatchMention: follow-up em thread que já tem card NÃO cria card novo", async () => {
  // Simula uma frente já existente na thread (ex.: Malu já foi acionada).
  track("painel:existe:marketing-lead", { title: "Campanha", agent: "Malu (Head de Marketing)", squad: "marketing", column: "execucao" }, "em curso");
  const antes = listBoard().filter((c) => c.key.startsWith("painel:existe:")).length;
  const r = await dispatchMention(
    "obrigado, ficou ótimo",
    { channel: "painel", threadTs: "existe", threadKey: "painel:existe" },
    deps(),
  );
  assert.equal(r, "pm");
  const depois = listBoard().filter((c) => c.key.startsWith("painel:existe:")).length;
  assert.equal(depois, antes, "follow-up não deve criar card (sem :pm)");
  assert.ok(!listBoard().some((c) => c.key === "painel:existe:pm"), "não deve existir card :pm");
});

test("dispatchMention: responde uma pergunta pendente da thread", async () => {
  const answered = askQuestion("painel:q", "Qual o público?", "Malu");
  const r = await dispatchMention("PMEs de tecnologia", { channel: "painel", threadTs: "q", threadKey: "painel:q" }, deps());
  assert.equal(r, "answered");
  assert.equal(await answered, "PMEs de tecnologia");
  assert.equal(listQuestions().length, 0);
});

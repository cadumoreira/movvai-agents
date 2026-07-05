import { test } from "node:test";
import assert from "node:assert/strict";
import { dueForReminder, pendingItems, splitThreadKey } from "../src/approvals/reminders.js";
import { register, resolvePending } from "../src/approvals/registry.js";
import { askQuestion, answerQuestion, resetQuestions } from "../src/approvals/questions.js";
import { isStatusCommand } from "../src/connectors/routing.js";
import { startDashboard } from "../src/web/server.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Auditoria em tmp: testes não escrevem o audit.log REAL do repo.
process.env.AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), "audit-prio-")), "audit.log");

// ── Lembretes de pendências humanas ─────────────────────────────────────────

test("dueForReminder: intervalo 0 desliga lembretes", () => {
  assert.equal(dueForReminder(new Date().toISOString(), undefined, Date.now(), 0), false);
});

test("dueForReminder: primeiro lembrete conta a partir do createdAt", () => {
  const now = Date.now();
  const createdAt = new Date(now - 31 * 60_000).toISOString();
  assert.equal(dueForReminder(createdAt, undefined, now, 30 * 60_000), true);
  const recente = new Date(now - 5 * 60_000).toISOString();
  assert.equal(dueForReminder(recente, undefined, now, 30 * 60_000), false);
});

test("dueForReminder: re-lembrete conta a partir do último lembrete", () => {
  const now = Date.now();
  const createdAt = new Date(now - 90 * 60_000).toISOString();
  // lembrado há 5min → ainda não; lembrado há 31min → sim
  assert.equal(dueForReminder(createdAt, now - 5 * 60_000, now, 30 * 60_000), false);
  assert.equal(dueForReminder(createdAt, now - 31 * 60_000, now, 30 * 60_000), true);
});

test("dueForReminder: createdAt inválido nunca dispara", () => {
  assert.equal(dueForReminder("não é data", undefined, Date.now(), 60_000), false);
});

test("splitThreadKey: separa canal e ts na PRIMEIRA vírgula de canal", () => {
  assert.deepEqual(splitThreadKey("C123:1720000000.123456"), {
    channel: "C123",
    threadTs: "1720000000.123456",
  });
  assert.equal(splitThreadKey("sem-separador"), null);
  assert.equal(splitThreadKey(":123.4"), null);
  assert.equal(splitThreadKey("C123:"), null);
});

test("pendingItems: unifica aprovações e perguntas com threadKey e resumo", async () => {
  resetQuestions();
  const ap = register("Publicar post no Instagram?\ndetalhes...", "C9:1.2");
  const q = askQuestion("C9:3.4", "Qual o público-alvo?", "Malu");

  const items = pendingItems();
  const aprovacao = items.find((i) => i.id === `ap:${ap.id}`);
  assert.ok(aprovacao, "aprovação registrada aparece");
  assert.equal(aprovacao?.kind, "aprovacao");
  assert.equal(aprovacao?.threadKey, "C9:1.2");
  assert.equal(aprovacao?.summary, "Publicar post no Instagram?");

  const pergunta = items.find((i) => i.kind === "pergunta");
  assert.ok(pergunta, "pergunta pendente aparece");
  assert.equal(pergunta?.threadKey, "C9:3.4");
  assert.match(pergunta?.summary ?? "", /Malu: Qual o público-alvo\?/);

  // decididas somem do snapshot
  resolvePending(ap.id, { approved: true }, "test");
  answerQuestion("C9:3.4", "PMEs de tecnologia", "test");
  await q;
  assert.equal(pendingItems().length, 0);
});

// ── Comando "status" no Slack ───────────────────────────────────────────────

test("isStatusCommand: reconhece pedido de status no começo da mensagem", () => {
  assert.equal(isStatusCommand("status"), true);
  assert.equal(isStatusCommand("  Status geral do time  "), true);
  assert.equal(isStatusCommand("@status"), true);
  assert.equal(isStatusCommand("status?"), true);
});

test("isStatusCommand: não aciona em palavras parecidas nem no meio do texto", () => {
  assert.equal(isStatusCommand("statusquo é outra coisa"), false);
  assert.equal(isStatusCommand("Sofia, status do post?"), false);
  assert.equal(isStatusCommand("qual o status?"), false);
});

// ── Nova demanda pelo painel (POST /api/demand) ─────────────────────────────

async function withDashboard(
  onDemand: Parameters<typeof startDashboard>[2],
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = startDashboard(0, undefined, onDemand);
  await new Promise((r) => server.once("listening", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("POST /api/demand: valida squad e texto, repassa ao handler", async () => {
  const calls: Array<{ squad: string; text: string }> = [];
  await withDashboard(
    async (squad, text) => {
      calls.push({ squad, text });
      return { ok: true };
    },
    async (base) => {
      const ok = await fetch(`${base}/api/demand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ squad: "marketing", text: "post de lançamento" }),
      });
      assert.equal(ok.status, 200);
      assert.deepEqual(calls, [{ squad: "marketing", text: "post de lançamento" }]);

      const semTexto = await fetch(`${base}/api/demand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ squad: "marketing", text: "   " }),
      });
      assert.equal(semTexto.status, 400);

      const squadInvalido = await fetch(`${base}/api/demand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ squad: "juridico", text: "algo" }),
      });
      assert.equal(squadInvalido.status, 400);
      assert.equal(calls.length, 1, "handler não é chamado com entrada inválida");
    },
  );
});

test("POST /api/demand: 503 quando o painel roda sem handler (modo demo)", async () => {
  await withDashboard(undefined, async (base) => {
    const res = await fetch(`${base}/api/demand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ squad: "produto", text: "algo" }),
    });
    assert.equal(res.status, 503);
  });
});

test("painel: exceção numa rota vira 500, sem derrubar o processo", async () => {
  await withDashboard(
    async () => {
      throw new Error("slack fora do ar");
    },
    async (base) => {
      const res = await fetch(`${base}/api/demand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ squad: "produto", text: "algo" }),
      });
      assert.equal(res.status, 500);
      // servidor continua respondendo depois do erro
      const alive = await fetch(`${base}/api/board`);
      assert.equal(alive.status, 200);
    },
  );
});

test("POST /api/demand: erro do handler vira 400 com a mensagem", async () => {
  await withDashboard(
    async () => ({ ok: false, error: "Defina SLACK_DEFAULT_CHANNEL" }),
    async (base) => {
      const res = await fetch(`${base}/api/demand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ squad: "sdr", text: "prospectar leads" }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error?: string };
      assert.match(body.error ?? "", /SLACK_DEFAULT_CHANNEL/);
    },
  );
});

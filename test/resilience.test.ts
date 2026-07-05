import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { track, listBoard, resetBoard, sweepStaleCards } from "../src/board/board.js";
import { InProcessQueue } from "../src/queue/index.js";
import { docPath, listDocs, readDoc, writeDoc } from "../src/web/docs-api.js";

beforeEach(() => resetBoard());

// ── Vigia de frentes órfãs ───────────────────────────────────────────────────

test("sweepStaleCards marca fila/execução paradas como falha; poupa aprovação e concluído", () => {
  const now = Date.now();
  track("a:1:dev", { title: "A", column: "execucao" });
  track("a:1:qa", { title: "B", column: "fila" });
  track("a:1:mkt-social", { title: "C", column: "aprovacao" }); // esperando humano: pode demorar
  track("a:1:pm", { title: "D", column: "concluido", outcome: "ok" });

  const swept = sweepStaleCards(30 * 60_000, now + 31 * 60_000);
  assert.deepEqual(swept.map((c) => c.key).sort(), ["a:1:dev", "a:1:qa"]);
  const board = listBoard();
  assert.equal(board.find((c) => c.key === "a:1:dev")?.outcome, "falha");
  assert.equal(board.find((c) => c.key === "a:1:mkt-social")?.column, "aprovacao"); // intocado
});

test("sweepStaleCards não mexe em frente recente", () => {
  track("b:1:dev", { title: "A", column: "execucao" });
  assert.deepEqual(sweepStaleCards(30 * 60_000), []);
});

// ── Retry da fila em processo ────────────────────────────────────────────────

test("InProcessQueue retenta handler que lança e desiste após o limite", async () => {
  // Polling (não espera fixa): runners de CI atrasam o event loop e flakeiam sleeps curtos.
  const until = async (cond: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  };

  const q = new InProcessQueue({ retries: 2, retryDelayMs: 5 });
  let calls = 0;
  q.process("dev-task", async () => {
    calls++;
    if (calls < 3) throw new Error("transiente");
  });
  await q.enqueue("dev-task", { channel: "c", threadTs: "1", threadKey: "c:1", ticket: { title: "x" }, instructions: "y" });
  await until(() => calls >= 3);
  assert.equal(calls, 3); // 1 tentativa + 2 retries → sucesso na 3ª

  // Falha permanente: para no teto, sem loop infinito.
  const q2 = new InProcessQueue({ retries: 1, retryDelayMs: 5 });
  let calls2 = 0;
  q2.process("qa-review", async () => {
    calls2++;
    throw new Error("sempre falha");
  });
  await q2.enqueue("qa-review", { channel: "c", threadTs: "1", threadKey: "c:1", repo: "o/r", branch: "b", prUrl: "u", prNumber: 1, title: "t" });
  await until(() => calls2 >= 2);
  await new Promise((r) => setTimeout(r, 40)); // folga: NÃO deve haver 3ª tentativa
  assert.equal(calls2, 2);
});

// ── API de curadoria (playbooks/marca) ───────────────────────────────────────

test("docPath valida ids e bloqueia path traversal", () => {
  assert.ok(docPath({ type: "skill", id: "mkt-social/formatos-por-canal" }));
  assert.ok(docPath({ type: "brand", id: "perfil" }));
  assert.equal(docPath({ type: "skill", id: "../../etc/passwd" }), null);
  assert.equal(docPath({ type: "brand", id: "a/b" }), null);
  assert.equal(docPath({ type: "skill", id: "semescopo" }), null);
});

test("listDocs/readDoc/writeDoc: ciclo completo em diretórios temporários", () => {
  process.env.SKILLS_DIR = mkdtempSync(join(tmpdir(), "sk-"));
  process.env.BRAND_DIR = mkdtempSync(join(tmpdir(), "br-"));
  try {
    assert.equal(writeDoc({ type: "brand", id: "perfil" }, "# Perfil novo"), true);
    assert.equal(writeDoc({ type: "skill", id: "mkt-social/tom" }, "# Tom"), true);
    assert.equal(writeDoc({ type: "skill", id: "../fuga" }, "x"), false);

    const docs = listDocs();
    assert.deepEqual(docs.map((d) => `${d.type}:${d.id}`).sort(), ["brand:perfil", "skill:mkt-social/tom"]);
    assert.equal(readDoc({ type: "brand", id: "perfil" }), "# Perfil novo");
    assert.equal(readDoc({ type: "brand", id: "inexistente" }), null);
  } finally {
    delete process.env.SKILLS_DIR;
    delete process.env.BRAND_DIR;
  }
});

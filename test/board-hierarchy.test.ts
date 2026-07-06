import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { track, resetBoard, boardTree, childrenOf, listBoard } from "../src/board/board.js";

process.env.AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), "audit-tree-")), "audit.log");

beforeEach(() => resetBoard());

/** Cria um pai e N filhos em "execucao". */
function demandaComFilhos(parent: string, filhos: string[]) {
  track(parent, { title: "Demanda", agent: "Rui (Tech Lead)", squad: "produto", column: "execucao" }, "decompondo");
  for (const f of filhos) {
    track(`${parent}/${f}`, { title: f, agent: "Téo (Dev)", squad: "produto", column: "execucao", parentKey: parent }, "na fila");
  }
}

test("rollup: pai só fecha quando TODOS os filhos concluem", () => {
  demandaComFilhos("dem", ["contrato", "endpoints"]);
  track("dem/contrato", { column: "concluido", outcome: "ok", deliverable: { kind: "doc", summary: "spec" } }, "ok");

  let parent = listBoard().find((c) => c.key === "dem")!;
  assert.equal(parent.column, "execucao", "pai continua em atuação com 1/2");
  assert.match(parent.notes.at(-1)!.text, /1\/2/);

  track("dem/endpoints", { column: "concluido", outcome: "ok", deliverable: { kind: "pr", summary: "PR #1" } }, "ok");
  parent = listBoard().find((c) => c.key === "dem")!;
  assert.equal(parent.column, "concluido");
  assert.equal(parent.outcome, "ok");
  assert.equal(parent.deliverable?.kind, "arvore", "pai agrega os filhos como entregável");
});

test("rollup: filho que falha derruba o pai", () => {
  demandaComFilhos("dem", ["a", "b"]);
  track("dem/a", { column: "concluido", outcome: "ok", deliverable: { kind: "pr", summary: "ok" } }, "ok");
  track("dem/b", { column: "concluido", outcome: "falha" }, "estourou");
  const parent = listBoard().find((c) => c.key === "dem")!;
  assert.equal(parent.column, "concluido");
  assert.equal(parent.outcome, "falha");
});

test("rollup: recursivo — subtarefa fecha tarefa que fecha a demanda", () => {
  track("D", { title: "Demanda", column: "execucao" }, "");
  track("D/T", { title: "Tarefa", column: "execucao", parentKey: "D" }, "");
  track("D/T/s1", { title: "s1", column: "execucao", parentKey: "D/T" }, "");
  track("D/T/s2", { title: "s2", column: "execucao", parentKey: "D/T" }, "");

  track("D/T/s1", { column: "concluido", outcome: "ok", deliverable: { kind: "thread", summary: "x" } }, "");
  assert.equal(listBoard().find((c) => c.key === "D")!.column, "execucao");
  track("D/T/s2", { column: "concluido", outcome: "ok", deliverable: { kind: "thread", summary: "y" } }, "");

  assert.equal(listBoard().find((c) => c.key === "D/T")!.column, "concluido", "tarefa fecha");
  assert.equal(listBoard().find((c) => c.key === "D")!.column, "concluido", "demanda fecha por rollup em cascata");
});

test("boardTree aninha filhos sob o pai; filho órfão vira raiz", () => {
  demandaComFilhos("dem", ["a", "b"]);
  track("solto", { title: "sem pai", column: "fila", parentKey: "pai-inexistente" }, "");
  const tree = boardTree();
  const dem = tree.find((n) => n.key === "dem")!;
  assert.equal(dem.children.length, 2);
  assert.deepEqual(dem.children.map((c) => c.title).sort(), ["a", "b"]);
  assert.ok(tree.some((n) => n.key === "solto"), "filho de pai inexistente aparece como raiz");
  assert.equal(childrenOf("dem").length, 2);
});

test("card carrega deliverable e parentKey", () => {
  track("k", { title: "t", column: "concluido", outcome: "ok", parentKey: "p", deliverable: { kind: "url", summary: "no ar", url: "https://x" } }, "");
  const c = listBoard().find((x) => x.key === "k")!;
  assert.equal(c.parentKey, "p");
  assert.equal(c.deliverable?.url, "https://x");
});

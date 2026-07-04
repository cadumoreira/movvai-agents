import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { track, listBoard, resetBoard, BOARD_COLUMNS } from "../src/board/board.js";

beforeEach(() => resetBoard());

test("track cria o card na fila por padrão e aplica o patch inicial", () => {
  const card = track("t1:dev", { title: "Bug X", agent: "Téo (Dev)", squad: "produto" }, "delegado");
  assert.equal(card.column, "fila");
  assert.equal(card.title, "Bug X");
  assert.deepEqual(card.notes.map((n) => n.text), ["delegado"]);
});

test("track é idempotente por chave: transições atualizam o mesmo card", () => {
  track("t1:dev", { title: "Bug X", agent: "Téo (Dev)", squad: "produto" });
  track("t1:dev", { column: "execucao" }, "trabalhando");
  const card = track("t1:dev", { column: "concluido", outcome: "ok" }, "PR aberto");
  assert.equal(listBoard().length, 1);
  assert.equal(card.column, "concluido");
  assert.equal(card.outcome, "ok");
  assert.equal(card.title, "Bug X"); // patch não sobrescreve com vazio
  assert.equal(card.notes.length, 2);
});

test("listBoard devolve os mais recentes primeiro", async () => {
  track("a", { title: "A" });
  await new Promise((r) => setTimeout(r, 5));
  track("b", { title: "B" });
  await new Promise((r) => setTimeout(r, 5));
  track("a", { column: "execucao" });
  assert.deepEqual(listBoard().map((c) => c.key), ["a", "b"]);
});

test("colunas do board são as quatro fases do fluxo", () => {
  assert.deepEqual([...BOARD_COLUMNS], ["fila", "execucao", "aprovacao", "concluido"]);
});

test("evicção descarta concluídos antigos primeiro ao passar do teto", () => {
  for (let i = 0; i < 150; i++) track(`done:${i}`, { title: `d${i}`, column: "concluido", outcome: "ok" });
  for (let i = 0; i < 60; i++) track(`live:${i}`, { title: `l${i}`, column: "execucao" });
  const cards = listBoard();
  assert.ok(cards.length <= 200);
  // Todos os ativos sobrevivem; só concluídos foram descartados.
  assert.equal(cards.filter((c) => c.column === "execucao").length, 60);
});

test("notas são limitadas às 20 mais recentes", () => {
  for (let i = 0; i < 25; i++) track("n", { column: "execucao" }, `nota ${i}`);
  const [card] = listBoard();
  assert.equal(card.notes.length, 20);
  assert.equal(card.notes[19].text, "nota 24");
});

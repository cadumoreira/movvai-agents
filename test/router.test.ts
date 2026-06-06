import { test } from "node:test";
import assert from "node:assert/strict";
import { routeModel } from "../src/models/router.js";

const STRONG = "anthropic:claude-opus-4-8";

test("roteia tarefa simples para o modelo barato", () => {
  const chosen = routeModel(STRONG, { text: "corrige um typo no README" });
  assert.notEqual(chosen, STRONG); // caiu para o CHEAP_MODEL (default haiku)
});

test("mantém o modelo forte em tarefa complexa (palavra-chave)", () => {
  const chosen = routeModel(STRONG, { text: "refatorar a arquitetura do módulo de auth" });
  assert.equal(chosen, STRONG);
});

test("mantém o modelo forte em tarefa longa", () => {
  const chosen = routeModel(STRONG, { text: "x".repeat(400) });
  assert.equal(chosen, STRONG);
});

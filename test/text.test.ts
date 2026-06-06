import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, clip, firstString } from "../src/util/text.js";

test("slugify remove acentos, espaços e pontuação", () => {
  assert.equal(slugify("Corrige Bug do Reset de Senha!"), "corrige-bug-do-reset-de-senha");
  assert.equal(slugify("Olá, Mundo"), "ola-mundo");
});

test("slugify limita o tamanho a 40 chars", () => {
  assert.ok(slugify("a".repeat(100)).length <= 40);
});

test("clip trunca acima do limite e preserva abaixo", () => {
  assert.equal(clip("abc", 10), "abc");
  const out = clip("a".repeat(50), 10);
  assert.ok(out.startsWith("a".repeat(10)));
  assert.ok(out.includes("truncado"));
});

test("firstString pega a primeira chave string não-vazia", () => {
  assert.equal(firstString({ a: "", b: "x", c: "y" }, ["a", "b", "c"]), "x");
  assert.equal(firstString({ n: 1 } as Record<string, unknown>, ["n", "z"]), undefined);
});

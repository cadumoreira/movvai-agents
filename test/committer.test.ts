import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNameStatus } from "../src/git/committer.js";

test("parseNameStatus lê add/modify/delete", () => {
  const out = "A\tsrc/novo.ts\nM\tsrc/velho.ts\nD\tsrc/antigo.ts";
  const changes = parseNameStatus(out);
  assert.deepEqual(changes, [
    { op: "A", path: "src/novo.ts" },
    { op: "M", path: "src/velho.ts" },
    { op: "D", path: "src/antigo.ts" },
  ]);
});

test("parseNameStatus trata rename como delete + add", () => {
  const changes = parseNameStatus("R100\tsrc/old.ts\tsrc/new.ts");
  assert.deepEqual(changes, [
    { op: "D", path: "src/old.ts" },
    { op: "A", path: "src/new.ts" },
  ]);
});

test("parseNameStatus ignora linhas vazias/inválidas", () => {
  assert.deepEqual(parseNameStatus("\n  \nM\ta.ts\n"), [{ op: "M", path: "a.ts" }]);
});

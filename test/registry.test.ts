import { test } from "node:test";
import assert from "node:assert/strict";
import { register, listPending, resolvePending } from "../src/approvals/registry.js";

test("register cria pendência listável e a promise resolve ao decidir", async () => {
  const { id, promise } = register("Abro o PR?");
  assert.ok(listPending().some((p) => p.id === id && p.text === "Abro o PR?"));

  const ok = resolvePending(id, { approved: true });
  assert.equal(ok, true);

  const decision = await promise;
  assert.equal(decision.approved, true);

  // já não está mais pendente
  assert.equal(listPending().some((p) => p.id === id), false);
});

test("resolvePending retorna false para id inexistente", () => {
  assert.equal(resolvePending("nao-existe", { approved: false }), false);
});

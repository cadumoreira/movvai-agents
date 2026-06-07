import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryThreadMemory } from "../src/memory/thread-memory.js";

test("InMemoryThreadMemory acumula e respeita o limite de mensagens", async () => {
  const mem = new InMemoryThreadMemory(3);
  await mem.append("t1", { role: "user", content: "a" });
  await mem.append("t1", { role: "assistant", content: "b" });
  assert.equal((await mem.get("t1")).length, 2);

  await mem.append("t1", { role: "user", content: "c" }, { role: "assistant", content: "d" });
  const msgs = await mem.get("t1");
  assert.equal(msgs.length, 3); // mantém só as últimas 3
  assert.equal((msgs[2] as { content: string }).content, "d");
});

test("threads são isoladas", async () => {
  const mem = new InMemoryThreadMemory();
  await mem.append("a", { role: "user", content: "x" });
  assert.equal((await mem.get("b")).length, 0);
});

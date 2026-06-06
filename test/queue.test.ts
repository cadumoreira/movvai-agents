import { test } from "node:test";
import assert from "node:assert/strict";
import { InProcessQueue } from "../src/queue/index.js";

test("InProcessQueue entrega o job ao processador", async () => {
  const q = new InProcessQueue();
  let received: { title: string } | undefined;

  q.process("delivery-summary", async (data) => {
    received = { title: data.title };
  });

  await q.enqueue("delivery-summary", {
    channel: "c",
    threadTs: "t",
    threadKey: "k",
    title: "Entrega X",
    prUrl: "http://pr",
    prNumber: 1,
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(received?.title, "Entrega X");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AUDIT_PATH = join(tmpdir(), `audit-test-${Date.now()}.log`);
process.env.AUDIT_LOG_PATH = AUDIT_PATH;

test("audit grava no buffer e no arquivo JSONL", async () => {
  const { audit, listAudit } = await import("../src/audit/log.js");

  audit({ kind: "approval", actor: "human", detail: "aprovado", meta: { id: "x" } });
  audit({ kind: "pr_opened", actor: "dev", detail: "http://pr/1" });

  const recent = listAudit();
  assert.equal(recent[0].kind, "pr_opened"); // mais recente primeiro
  assert.equal(recent[1].kind, "approval");

  const lines = readFileSync(AUDIT_PATH, "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.actor, "human");
  assert.ok(first.time);

  rmSync(AUDIT_PATH, { force: true });
});

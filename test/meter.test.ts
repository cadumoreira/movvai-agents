import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BILLING_PATH = join(tmpdir(), `billing-test-${Date.now()}.log`);
process.env.BILLING_LOG_PATH = BILLING_PATH;
process.env.ORG_ID = "acme";

const { meterUsage, billingSummary } = await import("../src/billing/meter.js");

test("meterUsage agrega custo/tokens por organização e persiste", () => {
  // 1M input no Opus 4.8 = $5; duas execuções = $10
  meterUsage("dev", "anthropic:claude-opus-4-8", {
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
  });
  meterUsage("qa", "anthropic:claude-opus-4-8", {
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
  });

  const summary = billingSummary();
  const acme = summary.find((o) => o.org === "acme");
  assert.ok(acme);
  assert.equal(acme.runs, 2);
  assert.equal(acme.costUSD, 10);
  assert.equal(acme.input, 2_000_000);

  const lines = readFileSync(BILLING_PATH, "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).org, "acme");

  rmSync(BILLING_PATH, { force: true });
});

import { test } from "node:test";
import assert from "node:assert/strict";

// Definido antes do import do config (cada arquivo de teste roda em processo isolado).
process.env.APPROVER_SLACK_IDS = "U1,U2";

const { canApprove, dashboardAuthorized } = await import("../src/auth/rbac.js");

test("canApprove respeita a allowlist", () => {
  assert.equal(canApprove("U1"), true);
  assert.equal(canApprove("U9"), false);
});

test("dashboardAuthorized é aberto sem token e exige Bearer com token", () => {
  delete process.env.DASHBOARD_TOKEN;
  assert.equal(dashboardAuthorized(undefined), true);

  process.env.DASHBOARD_TOKEN = "segredo";
  assert.equal(dashboardAuthorized("Bearer segredo"), true);
  assert.equal(dashboardAuthorized("Bearer errado"), false);
  assert.equal(dashboardAuthorized(undefined), false);
});

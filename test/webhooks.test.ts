import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyHmacSha256, parseGithubIssue, parseLinearIssue } from "../src/web/webhooks.js";

function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

test("verifyHmacSha256 aceita assinatura válida e rejeita inválida", () => {
  const body = '{"hello":"world"}';
  assert.equal(verifyHmacSha256("segredo", body, sign("segredo", body)), true);
  assert.equal(verifyHmacSha256("segredo", body, sign("errado", body)), false);
  assert.equal(verifyHmacSha256("", body, "x"), false);
});

test("parseGithubIssue aciona em label do agente", () => {
  const body = {
    action: "labeled",
    issue: { title: "Bug X", body: "passos", number: 7, html_url: "http://gh/7", labels: [{ name: "agent" }] },
  };
  const task = parseGithubIssue("issues", body, "agent");
  assert.equal(task?.title, "Bug X");
  assert.equal(task?.identifier, "#7");
  assert.ok(task?.instructions.includes("passos"));
});

test("parseGithubIssue ignora evento sem o label e tipo errado", () => {
  const body = { action: "labeled", issue: { title: "X", labels: [{ name: "outro" }] } };
  assert.equal(parseGithubIssue("issues", body, "agent"), null);
  assert.equal(parseGithubIssue("push", body, "agent"), null);
});

test("parseLinearIssue aciona com o label e extrai identificador", () => {
  const body = {
    type: "Issue",
    action: "update",
    data: { title: "Tarefa", description: "ctx", identifier: "LIN-9", url: "http://lin/9", labels: [{ name: "agent" }] },
  };
  const task = parseLinearIssue(body, "agent");
  assert.equal(task?.identifier, "LIN-9");
  assert.equal(parseLinearIssue({ type: "Comment" }, "agent"), null);
});

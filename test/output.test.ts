import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownToHtml, logPublication, listPublications } from "../src/publish/publishers.js";
import { publishTools } from "../src/tools/publish-tools.js";
import { sanitizeSlug } from "../src/tools/image.js";
import { b64url, buildJwtClaims, simplifyGa4Response } from "../src/tools/analytics.js";

// ── Publicação (feature 5) ───────────────────────────────────────────────────

test("markdownToHtml converte headings, listas, ênfase e links", () => {
  const html = markdownToHtml("# Título\nTexto **forte** e *leve*.\n- item [link](https://x.dev)\n\nOutro parágrafo");
  assert.match(html, /<h1>Título<\/h1>/);
  assert.match(html, /<strong>forte<\/strong>/);
  assert.match(html, /<em>leve<\/em>/);
  assert.match(html, /<ul><li>item <a href="https:\/\/x.dev">link<\/a><\/li><\/ul>/);
  assert.match(html, /<p>Outro parágrafo<\/p>/);
});

test("markdownToHtml escapa HTML malicioso", () => {
  assert.match(markdownToHtml("<script>alert(1)</script>"), /&lt;script&gt;/);
});

test("log de publicações grava e lê de volta (mais recentes primeiro)", () => {
  process.env.PUBLICATIONS_LOG_PATH = join(mkdtempSync(join(tmpdir(), "pub-")), "pub.log");
  logPublication({ channel: "blog", title: "Post A", by: "mkt-conteudo", url: "https://blog/a" });
  logPublication({ channel: "social", title: "Post B", by: "mkt-social" });
  const list = listPublications();
  assert.deepEqual(list.map((p) => p.title), ["Post B", "Post A"]);
  assert.equal(list[1].url, "https://blog/a");
  delete process.env.PUBLICATIONS_LOG_PATH;
});

test("ferramentas de publicação ficam TRAVADAS sem aprovação humana", async () => {
  const gate = { approved: false };
  const tools = publishTools("conteudo", { gate, personaId: "mkt-conteudo" });
  const locked = await (tools.publish_blog_post as { execute: Function }).execute(
    { title: "x", markdown: "y" },
    {},
  );
  assert.equal(locked.ok, false);
  assert.match(locked.error, /aprovação humana/);
});

test("cada disciplina recebe suas ferramentas de saída (Nina mede, não publica)", () => {
  const gate = { approved: false };
  assert.ok("publish_blog_post" in publishTools("conteudo", { gate, personaId: "x" }));
  assert.ok("send_email_campaign" in publishTools("conteudo", { gate, personaId: "x" }));
  assert.ok("schedule_social_post" in publishTools("social", { gate, personaId: "x" }));
  assert.ok("push_campaign_to_automation" in publishTools("ads", { gate, personaId: "x" }));
  assert.deepEqual(Object.keys(publishTools("seo", { gate, personaId: "x" })), []);
});

// ── Assets (feature 6) ───────────────────────────────────────────────────────

test("sanitizeSlug gera nome de arquivo seguro", () => {
  assert.equal(sanitizeSlug("Lançamento do Plano Pró!"), "lancamento-do-plano-pro");
  assert.equal(sanitizeSlug("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeSlug("!!!"), "asset");
  assert.ok(sanitizeSlug("x".repeat(200)).length <= 48);
});

// ── Analytics (feature 7) ────────────────────────────────────────────────────

test("b64url produz base64 URL-safe sem padding", () => {
  const out = b64url(Buffer.from([251, 255, 190]));
  assert.doesNotMatch(out, /[+/=]/);
});

test("buildJwtClaims monta o assertion do service account", () => {
  const c = buildJwtClaims("svc@proj.iam.gserviceaccount.com", ["https://scope/a", "https://scope/b"], 1000);
  assert.equal(c.iss, "svc@proj.iam.gserviceaccount.com");
  assert.equal(c.scope, "https://scope/a https://scope/b");
  assert.equal(c.aud, "https://oauth2.googleapis.com/token");
  assert.equal(c.exp - c.iat, 3600);
});

test("simplifyGa4Response achata dimensões e métricas em linhas", () => {
  const rows = simplifyGa4Response({
    dimensionHeaders: [{ name: "date" }],
    metricHeaders: [{ name: "activeUsers" }, { name: "sessions" }],
    rows: [
      { dimensionValues: [{ value: "20260701" }], metricValues: [{ value: "120" }, { value: "150" }] },
      { dimensionValues: [{ value: "20260702" }], metricValues: [{ value: "98" }, { value: "110" }] },
    ],
  });
  assert.deepEqual(rows[0], { date: "20260701", activeUsers: "120", sessions: "150" });
  assert.equal(rows.length, 2);
});

test("simplifyGa4Response tolera resposta vazia", () => {
  assert.deepEqual(simplifyGa4Response({}), []);
});

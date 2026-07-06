import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Armazém de artefatos num tmp isolado (não suja o repo).
process.env.ARTIFACTS_DIR = mkdtempSync(join(tmpdir(), "artifacts-"));
process.env.AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), "audit-doc-")), "audit.log");

const { saveArtifact, getArtifact, markdownToWordHtml } = await import("../src/artifacts/store.js");
const { documentTools } = await import("../src/tools/document.js");
const { track, listBoard, resetBoard } = await import("../src/board/board.js");

beforeEach(() => resetBoard());

test("saveArtifact grava e getArtifact recupera pelo id", () => {
  const a = saveArtifact("brief.doc", "<html>oi</html>");
  assert.match(a.url, /^\/artifacts\//);
  const got = getArtifact(a.id)!;
  assert.equal(got.body.toString(), "<html>oi</html>");
  assert.match(got.filename, /brief\.doc$/);
});

test("getArtifact rejeita id inválido (sem path traversal)", () => {
  assert.equal(getArtifact("../etc/passwd"), null);
  assert.equal(getArtifact("nao-existe"), null);
});

test("markdownToWordHtml converte headings, listas e negrito", () => {
  const html = markdownToWordHtml("Título", "# H1\n- item **forte**\ntexto");
  assert.match(html, /<h1>H1<\/h1>/);
  assert.match(html, /<li>item <strong>forte<\/strong><\/li>/);
  assert.match(html, /<p>texto<\/p>/);
  assert.match(html, /schemas-microsoft-com/); // abrível pelo Word
});

test("create_document gera o arquivo e ANEXA como entregável do card, com url", async () => {
  track("k", { title: "t", column: "execucao" }, "");
  const tools = documentTools("k");
  const out = await (tools.create_document as { execute: (i: unknown, o: unknown) => Promise<{ url: string }> }).execute(
    { filename: "relatorio", title: "Relatório X", content_markdown: "# Oi\ncorpo" },
    {},
  );
  assert.match(out.url, /^\/artifacts\//);
  const card = listBoard().find((c) => c.key === "k")!;
  assert.equal(card.deliverable?.kind, "doc");
  assert.equal(card.deliverable?.url, out.url);
  // e o arquivo existe/baixável
  const id = out.url.split("/").pop()!;
  assert.ok(getArtifact(id));
});

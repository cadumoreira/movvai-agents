import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brandProfile, brandPromptBlock, listBrandDocs, readBrandDoc, listBrandAssets } from "../src/brand/context.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "brand-"));
  writeFileSync(join(root, "perfil.md"), "---\nname: Perfil\n---\n## Quem somos\nA Acme vende foguetes.");
  writeFileSync(join(root, "brand-book.md"), "---\nname: Brand book\ndescription: Identidade visual.\n---\nRoxo #123456.");
  writeFileSync(join(root, "personas.md"), "Primeira linha vira descrição.\nCorpo.");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "logo.png"), "png-fake");
  writeFileSync(join(root, "assets", "LEIA-ME.md"), "ignorado");
  return root;
}

test("brandProfile lê o corpo do perfil (sem frontmatter)", () => {
  const root = fixture();
  assert.match(brandProfile(root) ?? "", /A Acme vende foguetes/);
  assert.doesNotMatch(brandProfile(root) ?? "", /name: Perfil/);
});

test("brandPromptBlock injeta o contexto; vazio sem perfil configurado", () => {
  const root = fixture();
  const block = brandPromptBlock(root);
  assert.match(block, /Contexto da marca\/empresa/);
  assert.match(block, /Acme/);
  assert.equal(brandPromptBlock("/nao/existe"), "");
});

test("listBrandDocs indexa os docs profundos (exceto o perfil), com fallbacks", () => {
  const root = fixture();
  const docs = listBrandDocs(root);
  assert.deepEqual(docs.map((d) => d.id), ["brand-book", "personas"]);
  assert.equal(docs[0].description, "Identidade visual.");
  assert.equal(docs[1].description, "Primeira linha vira descrição.");
});

test("readBrandDoc devolve o corpo e bloqueia path traversal", () => {
  const root = fixture();
  assert.match(readBrandDoc("brand-book", root) ?? "", /#123456/);
  assert.equal(readBrandDoc("../../etc/passwd", root), null);
  assert.equal(readBrandDoc("inexistente", root), null);
});

test("listBrandAssets lista arquivos com URL e ignora .md", () => {
  const root = fixture();
  const assets = listBrandAssets(root);
  assert.deepEqual(assets.map((a) => a.filename), ["logo.png"]);
  assert.match(assets[0].url, /\/brand-assets\/logo\.png$/);
});

test("diretório de marca inexistente = tudo vazio, sem lançar", () => {
  assert.equal(brandProfile("/nao/existe"), null);
  assert.deepEqual(listBrandDocs("/nao/existe"), []);
  assert.deepEqual(listBrandAssets("/nao/existe"), []);
});

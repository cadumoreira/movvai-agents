import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToBlocks, toRichText, type NotionBlock } from "../src/tools/notion.js";
import { normalizeDiscipline } from "../src/tools/marketing-delegate.js";

/** Lê o texto de um bloco (ex.: content(b, "heading_1")). */
function content(block: NotionBlock, type: string): string {
  const body = block[type] as { rich_text: Array<{ text: { content: string } }> };
  return body.rich_text.map((r) => r.text.content).join("");
}

test("markdownToBlocks converte headings, listas e parágrafos", () => {
  const blocks = markdownToBlocks(
    "# Brief\n## Objetivo\nAumentar signups.\n- LinkedIn\n- Instagram\n1. Semana 1\n\n### Métricas",
  );
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading_1", "heading_2", "paragraph", "bulleted_list_item", "bulleted_list_item", "numbered_list_item", "heading_3"],
  );
  assert.equal(content(blocks[0], "heading_1"), "Brief");
  assert.equal(content(blocks[3], "bulleted_list_item"), "LinkedIn");
});

test("markdownToBlocks ignora linhas vazias", () => {
  assert.equal(markdownToBlocks("\n\n  \n").length, 0);
});

test("toRichText fatia textos acima do limite de 2000 chars da API", () => {
  const rich = toRichText("x".repeat(4500));
  assert.equal(rich.length, 3);
  assert.equal(rich[0].text.content.length, 2000);
  assert.equal(rich[2].text.content.length, 500);
  assert.equal(rich.map((r) => r.text.content).join("").length, 4500);
});

test("markdownToBlocks propaga o fatiamento para linhas longas", () => {
  const [block] = markdownToBlocks("y".repeat(2500));
  const body = block.paragraph as { rich_text: unknown[] };
  assert.equal(body.rich_text.length, 2);
  assert.equal(content(block, "paragraph").length, 2500);
});

test("normalizeDiscipline reconhece sinônimos em PT/EN e acentos", () => {
  assert.equal(normalizeDiscipline("conteudo"), "conteudo");
  assert.equal(normalizeDiscipline("Conteúdo"), "conteudo");
  assert.equal(normalizeDiscipline("blog post"), "conteudo");
  assert.equal(normalizeDiscipline("social media"), "social");
  assert.equal(normalizeDiscipline("Instagram"), "social");
  assert.equal(normalizeDiscipline("tráfego pago"), "ads");
  assert.equal(normalizeDiscipline("campanha de ads"), "ads");
  assert.equal(normalizeDiscipline("SEO"), "seo");
  assert.equal(normalizeDiscipline("analytics"), "seo");
});

test("normalizeDiscipline devolve null para disciplina desconhecida", () => {
  assert.equal(normalizeDiscipline("jurídico"), null);
});

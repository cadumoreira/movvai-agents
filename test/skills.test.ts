import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, listSkills, loadSkill, hasSkills } from "../src/tools/skills.js";

/** Monta uma árvore de skills temporária para os testes. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  mkdirSync(join(root, "shared"));
  mkdirSync(join(root, "mkt-social"));
  writeFileSync(
    join(root, "shared", "tom.md"),
    "---\nname: Tom de voz\ndescription: Como a marca fala.\n---\nSeja direto.",
  );
  writeFileSync(join(root, "mkt-social", "canais.md"), "Primeira linha vira descrição.\nResto do corpo.");
  writeFileSync(join(root, "mkt-social", "notas.txt"), "não é markdown — deve ser ignorado");
  return root;
}

test("parseFrontmatter extrai meta e corpo", () => {
  const { meta, body } = parseFrontmatter("---\nname: X\ndescription: Y: com dois pontos\n---\ncorpo");
  assert.equal(meta.name, "X");
  assert.equal(meta.description, "Y: com dois pontos"); // só o PRIMEIRO ":" separa
  assert.equal(body, "corpo");
});

test("parseFrontmatter sem frontmatter devolve o texto como corpo", () => {
  const { meta, body } = parseFrontmatter("# Só corpo\ntexto");
  assert.deepEqual(meta, {});
  assert.equal(body, "# Só corpo\ntexto");
});

test("listSkills junta shared + as do papel, com fallbacks de nome/descrição", () => {
  const root = fixture();
  const skills = listSkills("mkt-social", root);
  assert.deepEqual(skills.map((s) => s.id), ["shared/tom", "mkt-social/canais"]);
  assert.equal(skills[0].name, "Tom de voz"); // do frontmatter
  assert.equal(skills[1].name, "canais"); // fallback: nome do arquivo
  assert.equal(skills[1].description, "Primeira linha vira descrição."); // fallback: 1ª linha
});

test("listSkills de outro papel só vê as compartilhadas", () => {
  const root = fixture();
  assert.deepEqual(listSkills("dev", root).map((s) => s.id), ["shared/tom"]);
  assert.equal(hasSkills("dev", root), true);
});

test("loadSkill devolve o corpo e respeita o escopo do papel", () => {
  const root = fixture();
  assert.equal(loadSkill("mkt-social", "shared/tom", root), "Seja direto.");
  assert.match(loadSkill("mkt-social", "mkt-social/canais", root) ?? "", /Primeira linha/);
  // Um papel não carrega skill privada de outro.
  assert.equal(loadSkill("dev", "mkt-social/canais", root), null);
});

test("loadSkill bloqueia path traversal e ids inválidos", () => {
  const root = fixture();
  assert.equal(loadSkill("mkt-social", "../../etc/passwd", root), null);
  assert.equal(loadSkill("mkt-social", "shared/../segredo", root), null);
  assert.equal(loadSkill("mkt-social", "inexistente/skill", root), null);
});

test("diretório inexistente = sem skills (sem lançar erro)", () => {
  assert.deepEqual(listSkills("qualquer", "/caminho/que/nao/existe"), []);
  assert.equal(hasSkills("qualquer", "/caminho/que/nao/existe"), false);
});

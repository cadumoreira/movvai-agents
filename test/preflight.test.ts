import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight, missingRequired, formatPreflight } from "../src/deps/preflight.js";

// CI roda sem nenhuma env de integração — o preflight deve refletir isso com precisão.

test("dev sem GITHUB_TOKEN tem dependência essencial ausente (aborta antes de gastar)", () => {
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN; // o getter da config lê a env na hora da checagem
  try {
    const missing = missingRequired(preflight("dev"));
    assert.ok(missing.some((m) => m.id === "github"));
    assert.ok(missing.every((m) => m.required && !m.ok));
    process.env.GITHUB_TOKEN = "tok";
    assert.ok(!missingRequired(preflight("dev")).some((m) => m.id === "github"));
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test("sandbox local não exige E2B; provider e2b sem chave é essencial ausente", () => {
  // default do ambiente de teste: SANDBOX_PROVIDER ausente e sem E2B_API_KEY → local → ok
  const sandbox = preflight("dev").find((c) => c.id === "sandbox");
  assert.equal(sandbox?.ok, true);
});

test("marketing não tem dependência essencial — tudo degrada com aviso", () => {
  for (const kind of ["marketing-lead", "conteudo", "social", "ads", "seo"] as const) {
    assert.deepEqual(missingRequired(preflight(kind)), [], `${kind} não deve bloquear`);
  }
});

test("cada disciplina verifica as SUAS integrações", () => {
  const ids = (kind: Parameters<typeof preflight>[0]) => preflight(kind).map((c) => c.id);
  assert.ok(ids("conteudo").includes("blog"));
  assert.ok(ids("conteudo").includes("email"));
  assert.ok(ids("social").includes("automacao"));
  assert.ok(ids("seo").includes("analytics"));
  assert.ok(!ids("seo").includes("blog")); // Nina não publica
});

test("brand/skills entram como dependência de conhecimento (repo tem exemplos → ok)", () => {
  const checks = preflight("social");
  assert.equal(checks.find((c) => c.id === "brand")?.ok, true);
  assert.equal(checks.find((c) => c.id === "skills")?.ok, true);
});

test("formatPreflight gera o mapa com degradação para o que falta", () => {
  const block = formatPreflight(preflight("social"));
  assert.match(block, /Dependências desta frente/);
  assert.match(block, /\[ok\] Contexto da marca/);
  assert.match(block, /\[FALTA\] Automação de publicação .* → sem automação/);
  assert.match(block, /ask_clarification/);
});

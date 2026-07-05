import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { until } from "./helpers.js";

// Auditoria em tmp: testes não escrevem o audit.log REAL do repo.
process.env.AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), "audit-orch-")), "audit.log");
import { validateTemplate, listTemplates, renderStep, fireTemplate } from "../src/orchestration/templates.js";
import { queue } from "../src/queue/index.js";
import { listBoard, resetBoard } from "../src/board/board.js";
import { parseSchedules } from "../src/schedule/scheduler.js";

beforeEach(() => resetBoard());

test("validateTemplate exige name/description/steps e targets válidos", () => {
  assert.ok(validateTemplate("t", { name: "N", description: "D", steps: [{ target: "produto", instructions: "x" }] }).template);
  assert.match(validateTemplate("t", { name: "N", description: "D", steps: [] }).error ?? "", /faltam/);
  assert.match(
    validateTemplate("t", { name: "N", description: "D", steps: [{ target: "juridico", instructions: "x" }] }).error ?? "",
    /target inválido/,
  );
});

test("renderStep substitui {demanda} em todas as ocorrências", () => {
  assert.equal(renderStep("Lance {demanda}. Anuncie {demanda}.", "o plano Pro"), "Lance o plano Pro. Anuncie o plano Pro.");
});

test("listTemplates lê o diretório ao vivo e ignora JSON inválido", () => {
  const dir = mkdtempSync(join(tmpdir(), "tpl-"));
  writeFileSync(join(dir, "ok.json"), JSON.stringify({ name: "OK", description: "d", steps: [{ target: "marketing", instructions: "i" }] }));
  writeFileSync(join(dir, "ruim.json"), "{{{");
  const list = listTemplates(dir);
  assert.deepEqual(list.map((t) => t.id), ["ok"]);
});

test("os templates de exemplo do repositório são válidos", () => {
  const list = listTemplates();
  assert.ok(list.some((t) => t.id === "lancamento-de-feature"));
  assert.ok(list.some((t) => t.id === "pacote-de-conteudo"));
});

test("fireTemplate enfileira cada passo na MESMA thread e cria os cards", async () => {
  const received: Array<{ job: string; threadKey: string; instructions: string }> = [];
  queue.process("techlead-task", async (d) => void received.push({ job: "techlead-task", threadKey: d.threadKey, instructions: d.instructions }));
  queue.process("marketing-task", async (d) => void received.push({ job: "marketing-task", threadKey: d.threadKey, instructions: d.instructions }));

  const t = {
    id: "lanc",
    name: "Lançamento",
    description: "d",
    steps: [
      { target: "produto" as const, instructions: "Implemente {demanda}" },
      { target: "marketing" as const, instructions: "Anuncie {demanda}" },
    ],
  };
  const targets = await fireTemplate(t, { channel: "C9", threadTs: "9.9", threadKey: "C9:9.9" }, "o modo escuro");
  await until(() => received.length >= 2);

  assert.deepEqual(targets, ["produto", "marketing"]);
  assert.equal(received.length, 2);
  assert.ok(received.every((r) => r.threadKey === "C9:9.9")); // MESMA thread
  assert.ok(received.find((r) => r.job === "techlead-task")?.instructions.includes("Implemente o modo escuro"));
  const cards = listBoard().filter((c) => c.key.startsWith("C9:9.9"));
  assert.deepEqual(cards.map((c) => c.agent).sort(), ["Malu (Head de Marketing)", "Rui (Tech Lead)"]);
});

test('parseSchedules aceita o target "delivery" (changelog)', () => {
  const { errors } = parseSchedules(
    JSON.stringify([{ name: "changelog", cron: "0 11 1,15 * *", target: "delivery", instructions: "compile" }]),
  );
  assert.equal(errors.length, 0);
});

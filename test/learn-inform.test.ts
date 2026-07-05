import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCurated, recordLesson } from "../src/learn/lessons.js";
import { listSkills } from "../src/tools/skills.js";
import { collectDigest, formatDigest } from "../src/digest/digest.js";
import { track, resetBoard } from "../src/board/board.js";
import { isFetchableUrl, htmlToText } from "../src/tools/web.js";
import { parseSchedules } from "../src/schedule/scheduler.js";

beforeEach(() => resetBoard());

// ── O time que aprende ───────────────────────────────────────────────────────

test("appendCurated cria o arquivo com frontmatter e acumula entradas datadas", () => {
  const root = mkdtempSync(join(tmpdir(), "learn-"));
  appendCurated("mkt-social", "licoes", "Headline com número supera adjetivo.", root);
  appendCurated("mkt-social", "licoes", "Post de terça 19h performa melhor.", root);
  const file = readFileSync(join(root, "mkt-social", "licoes.md"), "utf-8");
  assert.match(file, /SEMPRE consulte/);
  assert.match(file, /Headline com número/);
  assert.match(file, /terça 19h/);
  assert.equal((file.match(/^- \*\*/gm) ?? []).length, 2);
});

test("lições entram no circuito das skills (o agente as vê no índice)", () => {
  const root = mkdtempSync(join(tmpdir(), "learn2-"));
  recordLesson("mkt-social", "Nunca usar mais de 1 emoji por post.", root);
  const skills = listSkills("mkt-social", root);
  assert.ok(skills.some((s) => s.id === "mkt-social/licoes"));
});

// ── O time que informa ───────────────────────────────────────────────────────

test("collectDigest separa concluídas 24h, em andamento e pendências humanas", () => {
  const now = Date.now();
  track("d:1:pm", { title: "Antiga", column: "concluido", outcome: "ok" });
  // envelhece a antiga manualmente via updatedAt (simulado varrendo com now futuro)
  track("d:1:dev", { title: "Recente", agent: "Téo (Dev)", column: "concluido", outcome: "ok" });
  track("d:1:mkt-social", { title: "Rodando", agent: "Sofia (Social)", column: "execucao" });

  const d = collectDigest(now);
  assert.ok(d.doneLast24h.some((c) => c.title === "Recente"));
  assert.ok(d.inProgress.some((c) => c.title === "Rodando"));

  const text = formatDigest(d);
  assert.match(text, /Bom-dia do time/);
  assert.match(text, /Concluídas \(24h\)/);
  assert.match(text, /Esperando VOCÊ/);
});

test("isFetchableUrl bloqueia rede interna e protocolos estranhos", () => {
  assert.equal(isFetchableUrl("https://concorrente.com/pricing"), true);
  assert.equal(isFetchableUrl("http://localhost:3000"), false);
  assert.equal(isFetchableUrl("http://127.0.0.1/x"), false);
  assert.equal(isFetchableUrl("http://192.168.1.10/admin"), false);
  assert.equal(isFetchableUrl("http://10.0.0.5"), false);
  assert.equal(isFetchableUrl("http://172.20.3.4"), false);
  assert.equal(isFetchableUrl("file:///etc/passwd"), false);
  assert.equal(isFetchableUrl("não é url"), false);
});

test("htmlToText extrai texto legível e corta no teto", () => {
  const text = htmlToText("<html><script>x()</script><style>a{}</style><h1>Preço</h1><p>R$ 99&nbsp;/mês</p></html>");
  assert.equal(text, "Preço R$ 99 /mês");
  assert.equal(htmlToText(`<p>${"a".repeat(9000)}</p>`).length, 8000);
});

test('parseSchedules aceita o target "digest"', () => {
  const { schedules, errors } = parseSchedules(
    JSON.stringify([{ name: "bom-dia", cron: "0 9 * * 1-5", target: "digest", instructions: "-" }]),
  );
  assert.equal(errors.length, 0);
  assert.equal(schedules[0]?.target, "digest");
});

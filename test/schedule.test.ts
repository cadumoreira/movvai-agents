import { test } from "node:test";
import assert from "node:assert/strict";
import { parseField, matchesCron } from "../src/schedule/cron.js";
import { parseSchedules } from "../src/schedule/scheduler.js";

// segunda-feira, 2026-01-05 09:00 (local)
const seg9h = new Date(2026, 0, 5, 9, 0);

test("parseField expande *, listas, intervalos e passos", () => {
  assert.deepEqual([...parseField("*/15", 0, 59)], [0, 15, 30, 45]);
  assert.deepEqual([...parseField("1,3,5", 0, 59)], [1, 3, 5]);
  assert.deepEqual([...parseField("1-4", 0, 59)], [1, 2, 3, 4]);
  assert.deepEqual([...parseField("10-20/5", 0, 59)], [10, 15, 20]);
});

test("parseField rejeita valores fora do intervalo e sintaxe quebrada", () => {
  assert.throws(() => parseField("61", 0, 59));
  assert.throws(() => parseField("5-2", 0, 59));
  assert.throws(() => parseField("a", 0, 59));
  assert.throws(() => parseField("*/0", 0, 59));
});

test("matchesCron casa minuto/hora/dia-da-semana", () => {
  assert.equal(matchesCron("0 9 * * 1", seg9h), true); // segunda 9h
  assert.equal(matchesCron("0 9 * * 2", seg9h), false); // terça — não
  assert.equal(matchesCron("*/30 * * * *", new Date(2026, 0, 5, 14, 30)), true);
  assert.equal(matchesCron("0 9 * * 7", new Date(2026, 0, 4, 9, 0)), true); // 7 = domingo
});

test("matchesCron usa OR quando dia-do-mês E dia-da-semana são restritos", () => {
  // 2026-01-05 é segunda (dow 1) e dia 5. "dia 10 OU segunda" deve casar.
  assert.equal(matchesCron("0 9 10 * 1", seg9h), true);
  // "dia 10 OU sexta" não casa.
  assert.equal(matchesCron("0 9 10 * 5", seg9h), false);
});

test("matchesCron exige 5 campos", () => {
  assert.throws(() => matchesCron("0 9 * *", seg9h));
});

test("parseSchedules valida campos, target e cron", () => {
  const raw = JSON.stringify([
    { name: "ok", cron: "0 9 * * 1", target: "seo", instructions: "faça" },
    { name: "sem-instrucoes", cron: "0 9 * * 1", target: "seo" },
    { name: "target-ruim", cron: "0 9 * * 1", target: "juridico", instructions: "x" },
    { name: "cron-ruim", cron: "não é cron", target: "marketing", instructions: "x" },
  ]);
  const { schedules, errors } = parseSchedules(raw);
  assert.deepEqual(schedules.map((s) => s.name), ["ok"]);
  assert.equal(errors.length, 3);
});

test("parseSchedules tolera JSON inválido sem lançar", () => {
  assert.deepEqual(parseSchedules("{{{").schedules, []);
  assert.equal(parseSchedules("{}").errors.length, 1);
});

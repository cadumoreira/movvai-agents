import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deliberate, councilEnabled } from "../council/council.js";
import { initTelemetry } from "../observability/otel.js";

/**
 * Harness de eval (SCAFFOLD). Roda um golden set de decisões pelo conselho multi-modelo
 * e checa se a recomendação contém os termos esperados. Não roda no CI (precisa de chaves
 * e gasta tokens) — rode sob demanda com `npm run eval`.
 *
 * Evolução prevista: pass^k (rodar k vezes e exigir consistência), juiz LLM no lugar de
 * keyword-match, e gate de regressão contra um baseline congelado.
 */
interface EvalCase {
  name: string;
  question: string;
  context: string;
  expect: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(__dirname, "cases.json"), "utf-8")) as EvalCase[];

async function main() {
  initTelemetry();
  if (!councilEnabled()) {
    console.error("Defina COUNCIL_MODELS com ≥2 modelos (provedor:modelo) para rodar o eval.");
    process.exit(1);
  }

  let pass = 0;
  for (const c of cases) {
    const { recommendation } = await deliberate(c.question, c.context);
    const lower = recommendation.toLowerCase();
    const ok = c.expect.every((k) => lower.includes(k.toLowerCase()));
    console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}`);
    if (!ok) console.log(`  recomendação: ${recommendation.slice(0, 200)}`);
    if (ok) pass++;
  }

  console.log(`\n${pass}/${cases.length} casos passaram`);
  process.exit(pass === cases.length ? 0 : 1);
}

main().catch((err) => {
  console.error("Eval falhou:", err);
  process.exit(1);
});

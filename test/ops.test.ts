import { until } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentMention } from "../src/connectors/routing.js";
import { preflight, missingRequired } from "../src/deps/preflight.js";
import { delegateToOps } from "../src/tools/ops-delegate.js";
import { createOpsSpecialistAgent, opsSpecialistName } from "../src/agents/ops-specialist.js";
import { queue } from "../src/queue/index.js";
import { listBoard, resetBoard } from "../src/board/board.js";

beforeEach(() => resetBoard());

test("roteamento por nome alcança o squad de operações", () => {
  assert.deepEqual(resolveAgentMention("Igor, prospecta a ACME"), { kind: "ops", discipline: "sdr" });
  assert.deepEqual(resolveAgentMention("lia: responde esse cliente"), { kind: "ops", discipline: "suporte" });
  assert.deepEqual(resolveAgentMention("Otto — cobra a fatura de junho"), { kind: "ops", discipline: "financeiro" });
});

test("preflight de operações: e-mail é opcional (degrada para envio manual), nada bloqueia", () => {
  for (const kind of ["sdr", "suporte", "financeiro"] as const) {
    const checks = preflight(kind);
    assert.deepEqual(missingRequired(checks), [], `${kind} não deve bloquear`);
    const email = checks.find((c) => c.id === "email");
    assert.ok(email, `${kind} verifica Resend`);
    assert.match(email!.hint, /envio manual/);
    assert.equal(checks.find((c) => c.id === "skills")?.ok, true, `${kind} tem playbook de exemplo`);
  }
});

test("delegate_to_ops enfileira o job certo e cria o card do squad operações", async () => {
  const received: Array<{ discipline: string; threadKey: string }> = [];
  queue.process("ops-task", async (d) => void received.push({ discipline: d.discipline, threadKey: d.threadKey }));

  const tools = delegateToOps({ channel: "C7", threadTs: "7.7", threadKey: "C7:7.7", messenger: {} as never });
  const res = await (tools.delegate_to_ops as { execute: Function }).execute(
    { discipline: "suporte", title: "Responder cliente X", instructions: "texto do cliente..." },
    {},
  );
  await until(() => received.length > 0);

  assert.equal(res.ok, true);
  assert.equal(res.delegated_to, "suporte");
  assert.equal(res.specialist, "Lia (Suporte)");
  assert.deepEqual(received, [{ discipline: "suporte", threadKey: "C7:7.7" }]);
  const card = listBoard().find((c) => c.key === "C7:7.7:ops-suporte");
  assert.equal(card?.squad, "operacoes");
});

test("personas de operações: identidade, portão de envio e ferramentas por disciplina", async () => {
  const approve = async () => ({ approved: false });
  const igor = createOpsSpecialistAgent("sdr", { approve });
  const lia = createOpsSpecialistAgent("suporte", { approve });
  const otto = createOpsSpecialistAgent("financeiro", { approve });

  assert.equal(opsSpecialistName("sdr"), "Igor (SDR)");
  assert.ok("request_send_approval" in igor.tools && "request_send_approval" in lia.tools && "request_send_approval" in otto.tools);
  assert.ok("fetch_url" in igor.tools, "SDR pesquisa prospects na web");
  assert.ok(!("fetch_url" in otto.tools), "financeiro não precisa de web");

  // Envio recusado NÃO envia (sem thread → sem entrevista; retorna feedback vazio).
  const denied = await (igor.tools.request_send_approval as { execute: Function }).execute(
    { subject: "Oi", body_markdown: "corpo", context: "prospect X" },
    {},
  );
  assert.equal(denied.approved, false);
});

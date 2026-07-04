import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentMention } from "../src/connectors/routing.js";
import { askQuestion, answerQuestion, listQuestions, resetQuestions } from "../src/approvals/questions.js";
import { parseReviewVerdict } from "../src/agents/marketing-reviewer.js";

// ── Roteamento de follow-up na thread ────────────────────────────────────────

test("resolveAgentMention reconhece o squad de marketing (com acento, pontuação e @)", () => {
  assert.deepEqual(resolveAgentMention("Sofia, troca o tom do post 2"), {
    kind: "specialist",
    discipline: "social",
  });
  assert.deepEqual(resolveAgentMention("@caio: revisa o artigo"), {
    kind: "specialist",
    discipline: "conteudo",
  });
  assert.deepEqual(resolveAgentMention("NINA — como está o tráfego?"), { kind: "specialist", discipline: "seo" });
  assert.deepEqual(resolveAgentMention("Malu precisamos de campanha"), { kind: "lead" });
});

test("resolveAgentMention manda o time de produto para o fluxo da Ana", () => {
  assert.deepEqual(resolveAgentMention("Téo, adiciona um teste"), { kind: "pm" });
  assert.deepEqual(resolveAgentMention("ana tem um bug"), { kind: "pm" });
});

test("resolveAgentMention devolve null sem endereçamento (e não confunde palavras)", () => {
  assert.equal(resolveAgentMention("tem um bug no reset de senha"), null);
  assert.equal(resolveAgentMention("analisa esse erro"), null); // "analisa" ≠ "ana"
  assert.equal(resolveAgentMention(""), null);
});

// ── Perguntas de esclarecimento (briefing interativo) ────────────────────────

beforeEach(() => resetQuestions());

test("askQuestion pausa até answerQuestion entregar a resposta", async () => {
  const pending = askQuestion("C1:1", "Qual o prazo?", "Malu");
  assert.equal(listQuestions().length, 1);
  assert.equal(answerQuestion("C1:1", "sexta-feira"), true);
  assert.equal(await pending, "sexta-feira");
  assert.equal(listQuestions().length, 0);
});

test("answerQuestion devolve false sem pergunta pendente (fluxo normal segue)", () => {
  assert.equal(answerQuestion("C1:sem-pergunta", "oi"), false);
});

test("perguntas na mesma thread são respondidas em ordem (FIFO)", async () => {
  const q1 = askQuestion("C1:1", "Público?", "Malu");
  const q2 = askQuestion("C1:1", "Orçamento?", "Leo");
  answerQuestion("C1:1", "PMEs");
  answerQuestion("C1:1", "R$ 5k");
  assert.equal(await q1, "PMEs");
  assert.equal(await q2, "R$ 5k");
});

// ── Veredito da revisora (Vera) ──────────────────────────────────────────────

test("parseReviewVerdict extrai aprovado/ajustar (o ÚLTIMO veredito vale)", () => {
  assert.equal(parseReviewVerdict("Tudo consistente.\nVEREDITO: APROVADO").approved, true);
  const adjust = parseReviewVerdict("- Tom fora do playbook\nVEREDITO: AJUSTAR");
  assert.equal(adjust.approved, false);
  assert.match(adjust.feedback, /Tom fora/);
  // Se citar o formato e depois decidir, vale a decisão final.
  assert.equal(parseReviewVerdict("O formato pede VEREDITO: APROVADO ou não.\nVEREDITO: AJUSTAR").approved, false);
});

test("parseReviewVerdict sem veredito explícito aprova (fail-open, revisão é guarda)", () => {
  const v = parseReviewVerdict("Achei bom, sem observações.");
  assert.equal(v.approved, true);
});

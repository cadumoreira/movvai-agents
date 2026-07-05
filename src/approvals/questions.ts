import { audit } from "../audit/log.js";

/**
 * Perguntas de esclarecimento pendentes — a outra "interrupção durável" além da
 * aprovação: o agente pergunta na thread e PAUSA até o humano responder (mencionando
 * o bot na mesma thread). Fila FIFO por thread: perguntas são respondidas na ordem.
 *
 * MVP: em memória (mesmo padrão do registro de aprovações).
 */

interface PendingQuestion {
  question: string;
  askedBy: string;
  createdAt: string;
  resolve: (answer: string) => void;
}

const pending = new Map<string, PendingQuestion[]>();

/** Registra uma pergunta e espera a resposta humana chegar na thread. */
export function askQuestion(threadKey: string, question: string, askedBy: string): Promise<string> {
  return new Promise((resolve) => {
    const entry: PendingQuestion = { question, askedBy, createdAt: new Date().toISOString(), resolve };
    const list = pending.get(threadKey) ?? [];
    list.push(entry);
    pending.set(threadKey, list);
  });
}

/**
 * Entrega uma menção na thread como resposta à pergunta mais antiga pendente.
 * Retorna false se não havia pergunta esperando (a menção segue o fluxo normal).
 */
export function answerQuestion(threadKey: string, answer: string, actor = "human"): boolean {
  const list = pending.get(threadKey);
  const entry = list?.shift();
  if (!entry) return false;
  if (list && list.length === 0) pending.delete(threadKey);
  audit({
    kind: "clarification_answered",
    actor,
    detail: answer.slice(0, 200),
    meta: { question: entry.question, askedBy: entry.askedBy },
  });
  entry.resolve(answer);
  return true;
}

/** Perguntas pendentes (para o painel exibir, futuramente). */
export function listQuestions(): Array<{ threadKey: string; question: string; askedBy: string; createdAt: string }> {
  return [...pending.entries()].flatMap(([threadKey, list]) =>
    list.map(({ question, askedBy, createdAt }) => ({ threadKey, question, askedBy, createdAt })),
  );
}

/** Limpa o registro (usado em testes). */
export function resetQuestions(): void {
  pending.clear();
}

import { randomUUID } from "node:crypto";
import { audit } from "../audit/log.js";

export interface ApprovalDecision {
  approved: boolean;
  feedback?: string;
}

interface Entry {
  id: string;
  text: string;
  createdAt: string;
  /** Thread do Slack que originou (permite ao painel mostrar a aprovação NO card). */
  threadKey?: string;
  resolve: (d: ApprovalDecision) => void;
}

/**
 * Registro central de aprovações pendentes. Fonte única de verdade: tanto os botões do
 * Slack quanto o painel web listam/resolvem daqui — então você aprova de qualquer lugar.
 *
 * MVP: em memória. Persistir (Redis/DB) é o próximo passo para sobreviver a restart.
 */
const pending = new Map<string, Entry>();

export function register(text: string, threadKey?: string): { id: string; promise: Promise<ApprovalDecision> } {
  const id = randomUUID();
  let resolve!: (d: ApprovalDecision) => void;
  const promise = new Promise<ApprovalDecision>((r) => {
    resolve = r;
  });
  pending.set(id, { id, text, createdAt: new Date().toISOString(), threadKey, resolve });
  return { id, promise };
}

/** Remove uma pendência SEM decidir (ex.: falhou ao postar os botões no Slack). */
export function unregister(id: string): void {
  pending.delete(id);
}

export function listPending(): Array<{ id: string; text: string; createdAt: string; threadKey?: string }> {
  return [...pending.values()].map(({ id, text, createdAt, threadKey }) => ({ id, text, createdAt, threadKey }));
}

export function resolvePending(
  id: string,
  decision: ApprovalDecision,
  actor = "human",
): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  audit({
    kind: "approval",
    actor,
    detail: decision.approved ? "aprovado" : "recusado",
    meta: { id, text: entry.text },
  });
  entry.resolve(decision);
  return true;
}

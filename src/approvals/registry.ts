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
  resolve: (d: ApprovalDecision) => void;
}

/**
 * Registro central de aprovações pendentes. Fonte única de verdade: tanto os botões do
 * Slack quanto o painel web listam/resolvem daqui — então você aprova de qualquer lugar.
 *
 * MVP: em memória. Persistir (Redis/DB) é o próximo passo para sobreviver a restart.
 */
const pending = new Map<string, Entry>();

export function register(text: string): { id: string; promise: Promise<ApprovalDecision> } {
  const id = randomUUID();
  let resolve!: (d: ApprovalDecision) => void;
  const promise = new Promise<ApprovalDecision>((r) => {
    resolve = r;
  });
  pending.set(id, { id, text, createdAt: new Date().toISOString(), resolve });
  return { id, promise };
}

export function listPending(): Array<{ id: string; text: string; createdAt: string }> {
  return [...pending.values()].map(({ id, text, createdAt }) => ({ id, text, createdAt }));
}

export function resolvePending(id: string, decision: ApprovalDecision): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  audit({
    kind: "approval",
    actor: "human",
    detail: decision.approved ? "aprovado" : "recusado",
    meta: { id, text: entry.text },
  });
  entry.resolve(decision);
  return true;
}

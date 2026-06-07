import { appendFileSync } from "node:fs";
import { config } from "../config.js";

/**
 * Log de auditoria append-only das ações sensíveis do time (aprovações, PRs, tickets).
 * Dois destinos: arquivo JSONL durável (AUDIT_LOG_PATH) — pronto para enviar a um SIEM —
 * e um buffer em memória para o painel exibir ao vivo.
 */
export interface AuditEvent {
  kind: string; // ex.: "approval", "pr_opened", "ticket_created"
  actor: string; // quem agiu (humano, pm, dev...)
  detail: string;
  meta?: Record<string, unknown>;
}

export type AuditRecord = AuditEvent & { time: string; org: string };

const MAX = 500;
const ring: AuditRecord[] = [];

export function audit(event: AuditEvent): void {
  const record: AuditRecord = { time: new Date().toISOString(), org: config.security.orgId, ...event };
  ring.push(record);
  if (ring.length > MAX) ring.shift();
  try {
    appendFileSync(config.audit.path, JSON.stringify(record) + "\n");
  } catch (err) {
    console.error("Falha ao escrever no log de auditoria:", err);
  }
}

export function listAudit(limit = 100): AuditRecord[] {
  return ring.slice(-limit).reverse();
}

import { config } from "../config.js";

/**
 * Controle de acesso (RBAC) — funções puras, fáceis de testar.
 */

/** Pode aprovar via Slack? Vazio na allowlist = qualquer um (compat/local). */
export function canApprove(slackUserId: string): boolean {
  const allow = config.security.approverSlackIds;
  return allow.length === 0 || allow.includes(slackUserId);
}

/** Requisição ao painel autorizada? Sem token configurado = aberto (local). */
export function dashboardAuthorized(authHeader: string | undefined): boolean {
  const token = config.security.dashboardToken;
  if (!token) return true;
  return authHeader === `Bearer ${token}`;
}

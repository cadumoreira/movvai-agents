import { track, type BoardCard } from "../board/board.js";
import { preflight, missingRequired, type DependencyCheck, type WorkKind } from "../deps/preflight.js";

/**
 * Preflight comum a TODOS os workers (produto, marketing e operações): dependência
 * ESSENCIAL ausente aborta ANTES de gastar tokens — card vira falha com nota e a
 * thread recebe o aviso. Retorna as checagens (para anexar ao prompt via
 * formatPreflight) ou null quando abortou.
 */
export async function preflightOrAbort(
  kind: WorkKind,
  info: { cardKey: string; title: string; agent: string; squad: BoardCard["squad"] },
  post: (text: string) => Promise<unknown>,
): Promise<DependencyCheck[] | null> {
  const checks = preflight(kind);
  const missing = missingRequired(checks);
  if (!missing.length) return checks;
  track(
    info.cardKey,
    { title: info.title, agent: info.agent, squad: info.squad, column: "concluido", outcome: "falha" },
    "dependências essenciais ausentes",
  );
  // Aviso é best-effort: falha no Slack não pode virar retry do job (re-gastaria a fila).
  await post(
    `:warning: Não consigo começar *${info.title}* — falta: ${missing.map((m) => `${m.label} (${m.hint})`).join("; ")}.`,
  ).catch(() => undefined);
  return null;
}

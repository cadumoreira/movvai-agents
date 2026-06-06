import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifica HMAC-SHA256 de forma resistente a timing. `sigHeader` pode ter prefixo "sha256=". */
export function verifyHmacSha256(secret: string, rawBody: string, sigHeader: string): boolean {
  if (!secret || !sigHeader) return false;
  const provided = sigHeader.startsWith("sha256=") ? sigHeader.slice(7) : sigHeader;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface InboundTask {
  title: string;
  instructions: string;
  url?: string;
  identifier?: string;
}

/**
 * Extrai uma tarefa de um evento de issue do GitHub, se for acionável.
 * Aciona em `opened` ou quando recebe o label do agente (se `triggerLabel` definido).
 */
export function parseGithubIssue(
  event: string | undefined,
  body: Record<string, unknown>,
  triggerLabel: string,
): InboundTask | null {
  if (event !== "issues") return null;
  const action = body.action as string | undefined;
  const issue = body.issue as Record<string, unknown> | undefined;
  if (!issue) return null;

  const labels = Array.isArray(issue.labels)
    ? (issue.labels as Array<{ name?: string }>).map((l) => l.name)
    : [];
  const labeledForAgent = action === "labeled" && labels.includes(triggerLabel);
  const openedForAgent = action === "opened" && (!triggerLabel || labels.includes(triggerLabel));
  if (!labeledForAgent && !openedForAgent) return null;

  const title = String(issue.title ?? "Issue do GitHub");
  return {
    title,
    instructions: `${title}\n\n${String(issue.body ?? "")}`.trim(),
    url: typeof issue.html_url === "string" ? issue.html_url : undefined,
    identifier: typeof issue.number === "number" ? `#${issue.number}` : undefined,
  };
}

/**
 * Extrai uma tarefa de um evento de issue do Linear, se for acionável.
 * Aciona quando a issue ganha o label do agente.
 */
export function parseLinearIssue(
  body: Record<string, unknown>,
  triggerLabel: string,
): InboundTask | null {
  if (body.type !== "Issue") return null;
  const data = body.data as Record<string, unknown> | undefined;
  if (!data) return null;

  const labels = Array.isArray(data.labels)
    ? (data.labels as Array<{ name?: string }>).map((l) => l.name)
    : [];
  if (triggerLabel && !labels.includes(triggerLabel)) return null;

  const title = String(data.title ?? "Issue do Linear");
  return {
    title,
    instructions: `${title}\n\n${String(data.description ?? "")}`.trim(),
    url: typeof data.url === "string" ? data.url : undefined,
    identifier: typeof data.identifier === "string" ? data.identifier : undefined,
  };
}

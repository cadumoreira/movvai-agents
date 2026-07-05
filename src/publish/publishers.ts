import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { config } from "../config.js";
import { audit } from "../audit/log.js";

/**
 * Camada de publicação: transforma o entregável aprovado em RESULTADO — post no blog
 * (WordPress), e-mail (Resend) e social/automação (webhook genérico p/ Zapier/Make/n8n,
 * que alcança qualquer rede sem acoplar o core a uma plataforma).
 *
 * Segurança: quem chama é a ferramenta do agente, que só libera DEPOIS da aprovação
 * humana. WordPress publica como RASCUNHO por padrão (WORDPRESS_STATUS=publish p/ ir ao ar).
 * Toda publicação vira uma linha no log JSONL — é o que fecha o loop com as métricas.
 */

export interface PublicationRecord {
  time: string;
  channel: "blog" | "email" | "social" | "automation";
  title: string;
  url?: string;
  by: string;
  threadKey?: string;
  meta?: Record<string, unknown>;
}

export function logPublication(rec: Omit<PublicationRecord, "time">): void {
  const record: PublicationRecord = { time: new Date().toISOString(), ...rec };
  try {
    appendFileSync(config.publish.logPath, JSON.stringify(record) + "\n");
  } catch (err) {
    console.error("Falha ao escrever no log de publicações:", err);
  }
  audit({ kind: "published", actor: rec.by, detail: `${rec.channel}: ${rec.title}`, meta: { url: rec.url } });
}

/** Últimas publicações (mais recentes primeiro) — insumo do relatório da Nina. */
export function listPublications(limit = 20): PublicationRecord[] {
  const path = config.publish.logPath;
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as PublicationRecord)
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Conversor mínimo de Markdown → HTML para o corpo do post (headings, listas,
 * negrito/itálico/links e parágrafos). Determinístico e sem dependências.
 */
export function markdownToHtml(md: string): string {
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

  const out: string[] = [];
  let list: string[] | null = null;
  const flushList = () => {
    if (list) out.push("<ul>" + list.map((i) => `<li>${i}</li>`).join("") + "</ul>");
    list = null;
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      continue;
    }
    if (/^### /.test(line)) { flushList(); out.push(`<h3>${inline(line.slice(4))}</h3>`); }
    else if (/^## /.test(line)) { flushList(); out.push(`<h2>${inline(line.slice(3))}</h2>`); }
    else if (/^# /.test(line)) { flushList(); out.push(`<h1>${inline(line.slice(2))}</h1>`); }
    else if (/^[-*] /.test(line)) { (list ??= []).push(inline(line.slice(2))); }
    else { flushList(); out.push(`<p>${inline(line)}</p>`); }
  }
  flushList();
  return out.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── WordPress (REST API v2, Application Password) ───────────────────────────

export async function publishWordPress(opts: {
  title: string;
  markdown: string;
  excerpt?: string;
}): Promise<{ ok: boolean; url?: string; status?: string; error?: string }> {
  const { baseUrl, username, appPassword, status } = config.publish.wordpress;
  if (!baseUrl || !username || !appPassword) {
    return { ok: false, error: "WordPress não configurado (WORDPRESS_BASE_URL/USERNAME/APP_PASSWORD)." };
  }
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${username}:${appPassword}`).toString("base64"),
    },
    body: JSON.stringify({ title: opts.title, content: markdownToHtml(opts.markdown), excerpt: opts.excerpt, status }),
  });
  if (!res.ok) return { ok: false, error: `WordPress respondeu ${res.status}.` };
  const data = (await res.json()) as { link?: string; status?: string };
  return { ok: true, url: data.link, status: data.status };
}

// ── E-mail (Resend) ──────────────────────────────────────────────────────────

export async function sendEmailResend(opts: {
  subject: string;
  markdown: string;
  to?: string[];
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const { apiKey, from, to } = config.publish.resend;
  // Allowlist server-side: o agente só envia para quem está em EMAIL_TO — um brief
  // malicioso não escolhe destinatário arbitrário (spam/exfiltração).
  if (opts.to?.length && opts.to.some((r) => !to.includes(r))) {
    return { ok: false, error: "Destinatário fora da allowlist EMAIL_TO — adicione lá ou remova o parâmetro to." };
  }
  const recipients = opts.to?.length ? opts.to : to;
  if (!apiKey || !from) return { ok: false, error: "Resend não configurado (RESEND_API_KEY/EMAIL_FROM)." };
  if (!recipients.length) return { ok: false, error: "Sem destinatários (EMAIL_TO ou parâmetro to)." };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from, to: recipients, subject: opts.subject, html: markdownToHtml(opts.markdown) }),
  });
  if (!res.ok) return { ok: false, error: `Resend respondeu ${res.status}.` };
  const data = (await res.json()) as { id?: string };
  return { ok: true, id: data.id };
}

// ── Social/automação (webhook genérico: Zapier, Make, n8n…) ─────────────────

export async function publishWebhook(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const url = config.publish.webhookUrl;
  if (!url) return { ok: false, error: "Webhook de publicação não configurado (PUBLISH_WEBHOOK_URL)." };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.ok ? { ok: true } : { ok: false, error: `Webhook respondeu ${res.status}.` };
}

import { tool, type ToolSet } from "ai";
import { z } from "zod";

/**
 * Leitura de páginas públicas (radar de concorrência, pesquisa de referência).
 * Guarda anti-SSRF: só http(s) e nunca hosts locais/privados — o agente não pode
 * usar isso para alcançar a sua rede interna.
 */

const PRIVATE_HOST =
  /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)|(\.local)$|^\[?::1\]?$/i;

/** URL que o agente PODE buscar? (http/https público). */
export function isFetchableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (PRIVATE_HOST.test(url.hostname)) return false;
  return true;
}

/** HTML → texto legível: remove script/style/tags, decodifica o básico, compacta espaços. */
export function htmlToText(html: string, cap = 8000): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, cap);
}

export function webTools(): ToolSet {
  return {
    fetch_url: tool({
      description:
        "Lê uma página pública da web (texto extraído, até ~8k chars). Use para radar de concorrência, " +
        "checar um link do brief ou pesquisar referência. Só páginas públicas — nada de rede interna.",
      inputSchema: z.object({
        url: z.string().describe("URL completa (https://...)."),
      }),
      execute: async ({ url }) => {
        if (!isFetchableUrl(url)) return { ok: false, error: "URL não permitida (só http/https públicos)." };
        try {
          const res = await fetch(url, {
            redirect: "follow",
            signal: AbortSignal.timeout(15_000),
            headers: { "User-Agent": "movvai-agents/1.0 (radar)" },
          });
          if (!res.ok) return { ok: false, error: `Página respondeu ${res.status}.` };
          const type = res.headers.get("content-type") ?? "";
          const body = await res.text();
          const text = type.includes("html") ? htmlToText(body) : body.slice(0, 8000);
          return { ok: true, url: res.url, text };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  };
}

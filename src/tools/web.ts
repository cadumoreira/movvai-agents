import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Leitura de páginas públicas (radar de concorrência, pesquisa de referência).
 * Guarda anti-SSRF em três camadas — o agente não pode usar isso para alcançar
 * a sua rede interna nem metadados de nuvem:
 *   1. String da URL: só http(s), sem hostnames obviamente internos/numéricos.
 *   2. IP RESOLVIDO: todo endereço retornado pelo DNS precisa ser público
 *      (cobre IP decimal/octal/hex, IPv6 mapeado, domínio que aponta pra dentro).
 *   3. Redirects seguidos MANUALMENTE, revalidando as camadas 1-2 a cada salto.
 * Janela residual: rebinding DNS entre a checagem e o connect (mitigar por rede).
 */

const PRIVATE_HOST = /^(localhost$)|(\.local$)|(\.internal$)|(^metadata\.google\.internal$)/i;

/** URL que o agente PODE buscar? (camada 1 — barata e síncrona). */
export function isFetchableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE_HOST.test(host)) return false;
  // IP literal (qualquer família/formato) decide já pela faixa.
  if (isIP(host) || host.includes(":")) return !isPrivateIp(host);
  // Hostname "numérico" (2130706433, 0x7f.1, 0177.0.0.1): o resolvedor trataria
  // como IPv4 em formato alternativo — bloqueia na string mesmo.
  if (/^[0-9x.]+$/i.test(host)) return false;
  return true;
}

function privateV4(parts: number[]): boolean {
  const [a, b] = parts;
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true; // "esta rede", privada, loopback
  if (a === 169 && b === 254) return true; // link-local / metadados de nuvem
  if (a === 172 && b >= 16 && b <= 31) return true; // privada
  if (a === 192 && b === 168) return true; // privada
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reservado, broadcast
  return false;
}

/** Expande IPv6 (aceita "::" e IPv4 embutido) para 8 grupos de 16 bits. */
function v6Groups(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[2].split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    s = v4[1] + (((p[0] << 8) | p[1]).toString(16)) + ":" + (((p[2] << 8) | p[3]).toString(16));
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && fill < 0) return null;
  const groups = [...head, ...(halves.length === 2 ? Array(fill).fill("0") : []), ...tail].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN,
  );
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
}

/** Endereço IP em faixa privada/reservada? Formato desconhecido = bloqueia. */
export function isPrivateIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4) return privateV4(bare.split(".").map(Number));
  const g = v6Groups(bare);
  if (!g) return true; // não parseia = não confia
  const embeddedV4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  if (g.slice(0, 6).every((x) => x === 0)) {
    // ::, ::1 e v4-compatível (deprecado) — tudo bloqueado
    if (g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;
    return privateV4(embeddedV4);
  }
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateV4(embeddedV4); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4(embeddedV4); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local (deprecado)
  return false;
}

/** Camada 2: TODOS os IPs que o hostname resolve são públicos? Erro de DNS = não. */
export async function resolvesToPublicIp(hostname: string): Promise<boolean> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare) || bare.includes(":")) return !isPrivateIp(bare);
  try {
    const addrs = await lookup(bare, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
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

const MAX_REDIRECTS = 5;

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
        try {
          let current = url;
          for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (!isFetchableUrl(current) || !(await resolvesToPublicIp(new URL(current).hostname))) {
              return { ok: false, error: "URL não permitida (só http/https públicos)." };
            }
            const res = await fetch(current, {
              redirect: "manual", // cada salto passa pela guarda de novo
              signal: AbortSignal.timeout(15_000),
              headers: { "User-Agent": "movvai-agents/1.0 (radar)" },
            });
            if (res.status >= 300 && res.status < 400) {
              const loc = res.headers.get("location");
              if (!loc) return { ok: false, error: `Página respondeu ${res.status} sem destino.` };
              current = new URL(loc, current).toString();
              continue;
            }
            if (!res.ok) return { ok: false, error: `Página respondeu ${res.status}.` };
            const type = res.headers.get("content-type") ?? "";
            const body = await res.text();
            const text = type.includes("html") ? htmlToText(body) : body.slice(0, 8000);
            return { ok: true, url: current, text };
          }
          return { ok: false, error: "Redirects demais — abortado." };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  };
}

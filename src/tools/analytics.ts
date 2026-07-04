import { readFileSync, existsSync } from "node:fs";
import { createSign } from "node:crypto";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { config } from "../config.js";
import { listPublications } from "../publish/publishers.js";

/**
 * Métricas pós-campanha: a Nina lê números REAIS do GA4 (Data API) e do Search
 * Console e cruza com o log de publicações — fecha o loop plan → execute → measure.
 *
 * Auth: service account do Google (JSON), JWT RS256 assinado com node:crypto —
 * sem SDK. Ativa só com GOOGLE_SERVICE_ACCOUNT_JSON (+ GA4_PROPERTY_ID / GSC_SITE_URL).
 */

export function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface JwtClaims {
  iss: string;
  scope: string;
  aud: string;
  iat: number;
  exp: number;
}

/** Claims do JWT de service account (expira em 1h — máximo do Google). */
export function buildJwtClaims(clientEmail: string, scopes: string[], nowSeconds: number): JwtClaims {
  return {
    iss: clientEmail,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function loadServiceAccount(): ServiceAccount | null {
  const raw = config.google.serviceAccountJson;
  if (!raw) return null;
  try {
    const text = existsSync(raw) ? readFileSync(raw, "utf-8") : raw; // caminho OU JSON inline
    const sa = JSON.parse(text) as Partial<ServiceAccount>;
    return sa.client_email && sa.private_key ? (sa as ServiceAccount) : null;
  } catch {
    return null;
  }
}

/** Token OAuth2 por escopo, com cache (~55min). */
const tokenCache = new Map<string, { token: string; expires: number }>();
async function getAccessToken(scopes: string[]): Promise<string> {
  const key = scopes.join(" ");
  const cached = tokenCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.token;

  const sa = loadServiceAccount();
  if (!sa) throw new Error("Service account do Google inválida/ausente (GOOGLE_SERVICE_ACCOUNT_JSON).");

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify(buildJwtClaims(sa.client_email, scopes, Math.floor(Date.now() / 1000))));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(sa.private_key));
  const jwt = `${header}.${claims}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Token do Google falhou (${res.status}).`);
  const data = (await res.json()) as { access_token: string };
  tokenCache.set(key, { token: data.access_token, expires: Date.now() + 55 * 60_000 });
  return data.access_token;
}

/** Achata a resposta do GA4 em linhas legíveis pelo agente. */
export function simplifyGa4Response(data: {
  dimensionHeaders?: Array<{ name: string }>;
  metricHeaders?: Array<{ name: string }>;
  rows?: Array<{ dimensionValues?: Array<{ value: string }>; metricValues?: Array<{ value: string }> }>;
}): Array<Record<string, string>> {
  const dims = (data.dimensionHeaders ?? []).map((d) => d.name);
  const mets = (data.metricHeaders ?? []).map((m) => m.name);
  return (data.rows ?? []).map((row) => {
    const out: Record<string, string> = {};
    dims.forEach((d, i) => (out[d] = row.dimensionValues?.[i]?.value ?? ""));
    mets.forEach((m, i) => (out[m] = row.metricValues?.[i]?.value ?? ""));
    return out;
  });
}

export function analyticsTools(): ToolSet {
  const tools: ToolSet = {
    list_recent_publications: tool({
      description:
        "Lista o que o time PUBLICOU recentemente (blog, e-mail, social, campanhas) com data e canal — " +
        "use para amarrar as métricas ao que foi ao ar.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional().describe("Quantas (default 20)."),
      }),
      execute: async ({ limit }) => ({ publications: listPublications(limit ?? 20) }),
    }),
  };

  if (config.google.serviceAccountJson && config.google.ga4PropertyId) {
    tools.ga4_report = tool({
      description:
        "Consulta o Google Analytics 4 (Data API): métricas por período e dimensão. Métricas comuns: " +
        "activeUsers, sessions, screenPageViews, conversions. Dimensões: date, pagePath, sessionSource.",
      inputSchema: z.object({
        start_date: z.string().describe('Início (YYYY-MM-DD ou "7daysAgo").'),
        end_date: z.string().describe('Fim (YYYY-MM-DD ou "today").'),
        metrics: z.array(z.string()).min(1).describe("Métricas GA4 (ex.: activeUsers, sessions)."),
        dimensions: z.array(z.string()).optional().describe("Dimensões (ex.: date, pagePath)."),
        limit: z.number().int().optional().describe("Máx. de linhas (default 20)."),
      }),
      execute: async ({ start_date, end_date, metrics, dimensions, limit }) => {
        try {
          const token = await getAccessToken(["https://www.googleapis.com/auth/analytics.readonly"]);
          const res = await fetch(
            `https://analyticsdata.googleapis.com/v1beta/properties/${config.google.ga4PropertyId}:runReport`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({
                dateRanges: [{ startDate: start_date, endDate: end_date }],
                metrics: metrics.map((name) => ({ name })),
                dimensions: (dimensions ?? []).map((name) => ({ name })),
                limit: limit ?? 20,
              }),
            },
          );
          if (!res.ok) return { ok: false, error: `GA4 respondeu ${res.status}.` };
          return { ok: true, rows: simplifyGa4Response(await res.json()) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }

  if (config.google.serviceAccountJson && config.google.gscSiteUrl) {
    tools.search_console_query = tool({
      description:
        "Consulta o Google Search Console: cliques, impressões, CTR e posição por query/página no período.",
      inputSchema: z.object({
        start_date: z.string().describe("Início (YYYY-MM-DD)."),
        end_date: z.string().describe("Fim (YYYY-MM-DD)."),
        dimensions: z.array(z.enum(["query", "page", "date", "country", "device"])).optional(),
        row_limit: z.number().int().optional().describe("Máx. de linhas (default 20)."),
      }),
      execute: async ({ start_date, end_date, dimensions, row_limit }) => {
        try {
          const token = await getAccessToken(["https://www.googleapis.com/auth/webmasters.readonly"]);
          const site = encodeURIComponent(config.google.gscSiteUrl);
          const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              startDate: start_date,
              endDate: end_date,
              dimensions: dimensions ?? ["query"],
              rowLimit: row_limit ?? 20,
            }),
          });
          if (!res.ok) return { ok: false, error: `Search Console respondeu ${res.status}.` };
          const data = (await res.json()) as { rows?: unknown[] };
          return { ok: true, rows: data.rows ?? [] };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }

  return tools;
}

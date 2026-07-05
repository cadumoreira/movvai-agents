import "dotenv/config";
import { Redis } from "ioredis";

/**
 * "Médico" da configuração: diz o que já está pronto e o que falta, canal por canal.
 * Lê o .env (via dotenv) sem disparar os getters que lançam erro. Presença é o sinal
 * principal; com --ping, faz uma checagem leve de autenticação em cada serviço.
 *
 *   npm run doctor            # só presença (offline, instantâneo)
 *   npm run doctor -- --ping  # + testa a credencial de verdade (rede)
 */

// "Presente" = valor real, não o placeholder do .env.example (xoxb-..., lin_api_..., etc).
const has = (k: string): boolean => {
  const v = (process.env[k] ?? "").trim();
  return Boolean(v) && !v.endsWith("...") && !v.includes("...");
};
const ping = process.argv.includes("--ping");

type Status = "ok" | "parcial" | "falta";
interface Check {
  canal: string;
  desbloqueia: string;
  need: string[]; // env vars obrigatórias juntas
  anyOf?: string[]; // OU: basta uma destas
  live?: () => Promise<string>; // checagem de rede (retorna nota; lança em falha)
}

function statusOf(c: Check): { status: Status; faltando: string[] } {
  const missing = c.need.filter((k) => !has(k));
  const anyOk = !c.anyOf || c.anyOf.some((k) => has(k));
  const anyMissing = c.anyOf && !anyOk ? [`um de: ${c.anyOf.join(" | ")}`] : [];
  const faltando = [...missing, ...anyMissing];
  const total = c.need.length + (c.anyOf ? 1 : 0);
  const have = total - faltando.length;
  if (have === 0) return { status: "falta", faltando };
  if (faltando.length) return { status: "parcial", faltando };
  return { status: "ok", faltando: [] };
}

async function withTimeout(p: Promise<Response>, ms = 8000): Promise<Response> {
  return (await Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), ms))])) as Response;
}

const CHECKS: Check[] = [
  {
    canal: "IA (modelos)",
    desbloqueia: "OBRIGATÓRIO — os agentes pensam",
    need: [],
    anyOf: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MODEL_GATEWAY_API_KEY"],
    // Valida a chave de VERDADE (presença não basta: "invalid x-api-key" só aparece no runtime).
    live: async () => {
      if (has("ANTHROPIC_API_KEY")) {
        const r = await withTimeout(
          fetch("https://api.anthropic.com/v1/models", {
            headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
          }),
        );
        if (r.status === 401 || r.status === 403) throw new Error("Anthropic recusou a chave (invalid x-api-key)");
        if (!r.ok) throw new Error(`Anthropic respondeu ${r.status}`);
        return "Anthropic — chave válida";
      }
      if (has("OPENAI_API_KEY")) {
        const r = await withTimeout(fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }));
        if (!r.ok) throw new Error(`OpenAI respondeu ${r.status}`);
        return "OpenAI — chave válida";
      }
      if (has("GOOGLE_GENERATIVE_AI_API_KEY")) {
        const r = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_GENERATIVE_AI_API_KEY}`));
        if (!r.ok) throw new Error(`Google respondeu ${r.status}`);
        return "Google — chave válida";
      }
      return "gateway configurado (não verificado)";
    },
  },
  {
    canal: "Linear",
    desbloqueia: "Produto — PM cria o ticket",
    need: ["LINEAR_API_KEY"],
    live: async () => {
      const r = await withTimeout(
        fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: process.env.LINEAR_API_KEY! },
          body: JSON.stringify({ query: "{ viewer { name } }" }),
        }),
      );
      const j = (await r.json()) as { data?: { viewer?: { name?: string } } };
      if (!j.data?.viewer) throw new Error("credencial recusada");
      return `logado como ${j.data.viewer.name}`;
    },
  },
  {
    canal: "GitHub",
    desbloqueia: "Produto — investiga o repo e abre PR",
    need: ["GITHUB_TOKEN", "GITHUB_DEFAULT_REPO"],
    live: async () => {
      const r = await withTimeout(
        fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "User-Agent": "movvai-doctor" } }),
      );
      if (!r.ok) throw new Error(`respondeu ${r.status}`);
      const j = (await r.json()) as { login?: string };
      return `logado como @${j.login}`;
    },
  },
  { canal: "E2B (sandbox)", desbloqueia: "Produto — Dev roda testes isolado", need: ["E2B_API_KEY"] },
  {
    canal: "Notion",
    desbloqueia: "Marketing — board de briefs/rascunhos",
    need: ["NOTION_API_KEY"],
    anyOf: ["NOTION_DATABASE_ID", "NOTION_PARENT_PAGE_ID"],
    live: async () => {
      const r = await withTimeout(
        fetch("https://api.notion.com/v1/users/me", { headers: { Authorization: `Bearer ${process.env.NOTION_API_KEY}`, "Notion-Version": "2022-06-28" } }),
      );
      if (!r.ok) throw new Error(`respondeu ${r.status}`);
      return "integração válida";
    },
  },
  {
    canal: "WordPress (blog)",
    desbloqueia: "Marketing — publica artigo",
    need: ["WORDPRESS_BASE_URL", "WORDPRESS_USERNAME", "WORDPRESS_APP_PASSWORD"],
    live: async () => {
      const r = await withTimeout(fetch(`${process.env.WORDPRESS_BASE_URL!.replace(/\/$/, "")}/wp-json`));
      if (!r.ok) throw new Error(`REST respondeu ${r.status}`);
      return "REST API acessível";
    },
  },
  {
    canal: "Resend (e-mail)",
    desbloqueia: "Marketing/Ops — envia e-mail",
    need: ["RESEND_API_KEY", "EMAIL_FROM", "EMAIL_TO"],
    live: async () => {
      const r = await withTimeout(fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } }));
      if (!r.ok) throw new Error(`respondeu ${r.status}`);
      return "chave válida";
    },
  },
  { canal: "Webhook social", desbloqueia: "Marketing — social/ads via Zapier/Make/n8n", need: ["PUBLISH_WEBHOOK_URL"] },
  { canal: "Imagens (criativos)", desbloqueia: "Marketing — generate_image", need: ["OPENAI_API_KEY"] },
  { canal: "Google (métricas)", desbloqueia: "Marketing — relatório GA4/Search Console", need: ["GOOGLE_SERVICE_ACCOUNT_JSON", "GA4_PROPERTY_ID"] },
  {
    canal: "Slack",
    desbloqueia: "Superfície extra (o painel já faz tudo)",
    // SLACK_DEFAULT_CHANNEL entra aqui: sem ele, com Slack ligado, demandas dão "sem canal para ancorar".
    need: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_DEFAULT_CHANNEL"],
    live: async () => {
      const r = await withTimeout(fetch("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }));
      const j = (await r.json()) as { ok?: boolean; team?: string; error?: string };
      if (!j.ok) throw new Error(j.error ?? "auth.test falhou");
      return `workspace ${j.team}`;
    },
  },
  {
    canal: "Redis (durabilidade)",
    desbloqueia: "Board + conversas persistem, jobs com retry",
    need: ["REDIS_URL"],
    // Conecta e dá PING de verdade (presença do REDIS_URL não garante que o Redis está no ar).
    live: async () => {
      const r = new Redis(process.env.REDIS_URL!, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        connectTimeout: 6000,
        retryStrategy: () => null,
      });
      try {
        await r.connect();
        return `respondeu ${await r.ping()}`;
      } finally {
        r.disconnect();
      }
    },
  },
];

const ICON: Record<Status, string> = { ok: "✅", parcial: "🟡", falta: "⬜" };

async function main() {
  console.log("\n🩺 Diagnóstico da configuração (movvai-agents)\n");
  const rows: string[] = [];
  let live: Record<string, string> = {};

  if (ping) {
    await Promise.all(
      CHECKS.filter((c) => c.live && statusOf(c).status !== "falta").map(async (c) => {
        try {
          live[c.canal] = "🔌 " + (await c.live!());
        } catch (e) {
          live[c.canal] = "❌ " + (e instanceof Error ? e.message : String(e));
        }
      }),
    );
  }

  for (const c of CHECKS) {
    const { status, faltando } = statusOf(c);
    const nota = status === "ok" ? (live[c.canal] ?? "configurado") : `faltando: ${faltando.join(", ")}`;
    rows.push(`${ICON[status]}  ${c.canal.padEnd(22)} ${c.desbloqueia}`);
    rows.push(`    ${nota}`);
  }
  console.log(rows.join("\n"));

  const iaOk = statusOf(CHECKS[0]).status === "ok";
  console.log("\n" + (iaOk ? "▶ IA configurada — dá pra rodar: npm run try:panel" : "⚠ Configure ao menos uma chave de IA para começar (bloco MODELOS no .env)."));
  if (!ping) console.log("  Dica: rode  npm run doctor -- --ping  para testar as credenciais de verdade.\n");
  else console.log("");
}

main().catch((err) => {
  console.error("doctor falhou:", err);
  process.exit(1);
});

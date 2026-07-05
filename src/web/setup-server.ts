import http from "node:http";
import { getValue, isSet, updateEnvFile } from "./env-store.js";

/** Campo de configuração exibido no backoffice. */
interface Field {
  key: string;
  label: string;
  type?: "text" | "secret" | "select";
  options?: string[];
  placeholder?: string;
  hint?: string;
}

interface Group {
  title: string;
  hint?: string;
  fields: Field[];
}

const GROUPS: Group[] = [
  {
    title: "Modelos por papel",
    hint: 'Formato "provedor:modelo" — provedores: anthropic, openai, google, ollama.',
    fields: [
      { key: "PM_MODEL", label: "PM (refino)", placeholder: "anthropic:claude-sonnet-4-6" },
      { key: "DEV_MODEL", label: "Dev (código)", placeholder: "anthropic:claude-opus-4-8" },
      { key: "QA_MODEL", label: "QA (revisão)", placeholder: "anthropic:claude-sonnet-4-6" },
      { key: "MARKETING_MODEL", label: "Marketing (squad)", placeholder: "anthropic:claude-sonnet-4-6" },
      { key: "CHEAP_MODEL", label: "Barato (tarefas simples)", placeholder: "anthropic:claude-haiku-4-5" },
    ],
  },
  {
    title: "Chaves de provedor",
    hint: "Preencha pelo menos uma, compatível com os modelos acima.",
    fields: [
      { key: "ANTHROPIC_API_KEY", label: "Anthropic", type: "secret", placeholder: "sk-ant-..." },
      { key: "OPENAI_API_KEY", label: "OpenAI", type: "secret", placeholder: "sk-..." },
      { key: "GOOGLE_GENERATIVE_AI_API_KEY", label: "Google Gemini", type: "secret" },
    ],
  },
  {
    title: "Conselho multi-modelo (opcional)",
    hint: "≥2 modelos separados por vírgula ativam o parecer colegiado em decisões de alto valor.",
    fields: [
      { key: "COUNCIL_MODELS", label: "Modelos", placeholder: "anthropic:claude-opus-4-8,openai:gpt-5" },
      { key: "COUNCIL_SYNTH_MODEL", label: "Sintetizador (opcional)" },
    ],
  },
  {
    title: "Sandbox (Dev executa código)",
    hint: "local = roda na sua máquina (sem conta). docker = contêiner local. e2b = microVM na nuvem.",
    fields: [
      { key: "SANDBOX_PROVIDER", label: "Provider", type: "select", options: ["local", "docker", "e2b"] },
      { key: "SANDBOX_DOCKER_IMAGE", label: "Imagem Docker", placeholder: "node:22" },
      { key: "E2B_API_KEY", label: "E2B API Key (se e2b)", type: "secret" },
    ],
  },
  {
    title: "Linear",
    fields: [
      { key: "LINEAR_API_KEY", label: "API Key", type: "secret", placeholder: "lin_api_..." },
      { key: "LINEAR_TEAM_KEY", label: "Time (sigla, ex.: ENG)" },
    ],
  },
  {
    title: "Jira (alternativa ao Linear)",
    fields: [
      { key: "JIRA_BASE_URL", label: "Base URL", placeholder: "https://suaorg.atlassian.net" },
      { key: "JIRA_EMAIL", label: "E-mail" },
      { key: "JIRA_API_TOKEN", label: "API Token", type: "secret" },
      { key: "JIRA_PROJECT_KEY", label: "Projeto (ex.: ENG)" },
    ],
  },
  {
    title: "Notion (squad de marketing)",
    hint: "Board do marketing: briefs e entregáveis. Preencha o database OU a página-mãe.",
    fields: [
      { key: "NOTION_API_KEY", label: "API Key (integração interna)", type: "secret", placeholder: "ntn_..." },
      { key: "NOTION_DATABASE_ID", label: "Database ID (um item por brief)" },
      { key: "NOTION_PARENT_PAGE_ID", label: "Página-mãe (alternativa ao database)" },
    ],
  },
  {
    title: "GitHub",
    fields: [
      { key: "GITHUB_TOKEN", label: "Token (PAT)", type: "secret", placeholder: "github_pat_..." },
      { key: "GITHUB_DEFAULT_REPO", label: "Repositório (owner/repo)", placeholder: "cadumoreira/movvai-agents" },
      { key: "GITHUB_WEBHOOK_SECRET", label: "Webhook Secret", type: "secret" },
    ],
  },
  {
    title: "Slack",
    fields: [
      { key: "SLACK_BOT_TOKEN", label: "Bot Token", type: "secret", placeholder: "xoxb-..." },
      { key: "SLACK_APP_TOKEN", label: "App Token", type: "secret", placeholder: "xapp-..." },
      { key: "SLACK_SIGNING_SECRET", label: "Signing Secret", type: "secret" },
      { key: "SLACK_DEFAULT_CHANNEL", label: "Canal padrão (ex.: C0123ABC)" },
    ],
  },
  {
    title: "Automação (webhooks de entrada)",
    fields: [
      { key: "LINEAR_WEBHOOK_SECRET", label: "Linear Webhook Secret", type: "secret" },
      { key: "AGENT_TRIGGER_LABEL", label: "Label que aciona o time", placeholder: "agent" },
    ],
  },
  {
    title: "Publicação (pós-aprovação)",
    hint: "Transforma entregável aprovado em resultado: blog, e-mail e social via automação.",
    fields: [
      { key: "WORDPRESS_BASE_URL", label: "WordPress URL", placeholder: "https://blog.suamarca.com" },
      { key: "WORDPRESS_USERNAME", label: "WordPress usuário" },
      { key: "WORDPRESS_APP_PASSWORD", label: "WordPress app password", type: "secret" },
      { key: "WORDPRESS_STATUS", label: "Status do post", type: "select", options: ["draft", "publish"] },
      { key: "RESEND_API_KEY", label: "Resend API Key (e-mail)", type: "secret", placeholder: "re_..." },
      { key: "EMAIL_FROM", label: "Remetente", placeholder: "news@suamarca.com" },
      { key: "EMAIL_TO", label: "Lista (e-mails, vírgula)" },
      { key: "PUBLISH_WEBHOOK_URL", label: "Webhook social/ads (Zapier/Make/n8n)" },
    ],
  },
  {
    title: "Métricas (Google) & assets",
    hint: "Nina lê GA4/Search Console (service account). Criativos exigem OPENAI_API_KEY.",
    fields: [
      { key: "GOOGLE_SERVICE_ACCOUNT_JSON", label: "Service account (caminho do .json ou JSON)", type: "secret" },
      { key: "GA4_PROPERTY_ID", label: "GA4 Property ID", placeholder: "123456789" },
      { key: "GSC_SITE_URL", label: "Search Console site", placeholder: "https://suamarca.com/" },
      { key: "ASSETS_DIR", label: "Pasta de assets", placeholder: "assets" },
      { key: "PUBLIC_BASE_URL", label: "URL pública do painel (p/ links de asset)" },
    ],
  },
  {
    title: "Acesso (RBAC) & organização",
    fields: [
      { key: "APPROVER_SLACK_IDS", label: "Aprovadores Slack (IDs, vírgula)" },
      { key: "DASHBOARD_TOKEN", label: "Token do painel (aprovar via web)", type: "secret" },
      { key: "ORG_ID", label: "Organização", placeholder: "default" },
    ],
  },
  {
    title: "Infra & custo",
    fields: [
      { key: "REDIS_URL", label: "Redis URL (fila/memória durável)" },
      { key: "DATABASE_URL", label: "Postgres URL (memória longa/pgvector)" },
      { key: "AGENT_TOKEN_BUDGET", label: "Orçamento de tokens por execução", placeholder: "400000" },
      { key: "DASHBOARD_PORT", label: "Porta do painel", placeholder: "3000" },
    ],
  },
  {
    title: "Observabilidade (OpenTelemetry → Langfuse)",
    fields: [
      { key: "LANGFUSE_PUBLIC_KEY", label: "Langfuse Public Key", type: "secret" },
      { key: "LANGFUSE_SECRET_KEY", label: "Langfuse Secret Key", type: "secret" },
      { key: "LANGFUSE_BASEURL", label: "Langfuse Base URL", placeholder: "https://cloud.langfuse.com" },
      { key: "OTEL_EXPORTER_OTLP_ENDPOINT", label: "OTLP Endpoint (alternativa)" },
    ],
  },
];

const ALL_FIELDS = GROUPS.flatMap((g) => g.fields);

/** Prontidão de cada capacidade, a partir do que está configurado. */
function health() {
  const hasModel = isSet("ANTHROPIC_API_KEY") || isSet("OPENAI_API_KEY") || isSet("GOOGLE_GENERATIVE_AI_API_KEY");
  const hasTickets = isSet("LINEAR_API_KEY") || (isSet("JIRA_BASE_URL") && isSet("JIRA_API_TOKEN"));
  const sandboxOk = (getValue("SANDBOX_PROVIDER") || "local") !== "e2b" || isSet("E2B_API_KEY");
  const slackOk = isSet("SLACK_BOT_TOKEN") && isSet("SLACK_APP_TOKEN") && isSet("SLACK_SIGNING_SECRET");
  return [
    {
      name: "PM cria tickets",
      ready: hasModel && hasTickets,
      hint: !hasModel ? "Falta uma chave de modelo (Anthropic/OpenAI/Google)" : !hasTickets ? "Falta o Linear (ou Jira)" : "",
    },
    {
      name: "Dev abre PR",
      ready: hasModel && isSet("GITHUB_TOKEN") && sandboxOk,
      hint: !isSet("GITHUB_TOKEN") ? "Falta o GitHub Token" : !sandboxOk ? "Sandbox e2b sem E2B_API_KEY" : "",
    },
    {
      name: "Marketing entrega no Notion",
      ready: hasModel && isSet("NOTION_API_KEY") && (isSet("NOTION_DATABASE_ID") || isSet("NOTION_PARENT_PAGE_ID")),
      hint: !isSet("NOTION_API_KEY")
        ? "Falta a NOTION_API_KEY"
        : !(isSet("NOTION_DATABASE_ID") || isSet("NOTION_PARENT_PAGE_ID"))
          ? "Falta o database OU a página-mãe do Notion"
          : "",
    },
    {
      name: "Time no Slack",
      ready: slackOk && hasModel,
      hint: !slackOk ? "Faltam os 3 tokens do Slack" : "",
    },
    {
      name: "Conselho",
      ready: getValue("COUNCIL_MODELS").split(",").filter(Boolean).length >= 2,
      hint: "Opcional — ≥2 modelos em COUNCIL_MODELS",
    },
    {
      name: "Observabilidade",
      ready: (isSet("LANGFUSE_PUBLIC_KEY") && isSet("LANGFUSE_SECRET_KEY")) || isSet("OTEL_EXPORTER_OTLP_ENDPOINT"),
      hint: "Opcional — Langfuse ou OTLP",
    },
  ];
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

export function startSetupServer(port: number): void {
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", `http://localhost:${port}`).pathname;

    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page());
      return;
    }
    if (req.method === "GET" && path === "/api/config") {
      // Segredos: só presença. Não-segredos: valor atual (para pré-preencher).
      const fields: Record<string, { set: boolean; value: string }> = {};
      for (const f of ALL_FIELDS) {
        fields[f.key] = { set: isSet(f.key), value: f.type === "secret" ? "" : getValue(f.key) };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fields, health: health() }));
      return;
    }
    if (req.method === "POST" && path === "/api/config") {
      const body = await readBody(req);
      let updates: Record<string, string> = {};
      try {
        updates = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "JSON inválido" }));
        return;
      }
      const safe: Record<string, string> = {};
      for (const f of ALL_FIELDS) if (typeof updates[f.key] === "string") safe[f.key] = updates[f.key];
      updateEnvFile(safe);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, saved: Object.keys(safe).filter((k) => safe[k]), health: health() }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(port, () => {
    console.log(`\n  Backoffice: abra http://localhost:${port} no navegador\n`);
  });
}

function page(): string {
  const groupsJson = JSON.stringify(GROUPS);
  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Dream Team — Backoffice</title>
<style>
  :root { color-scheme: light dark;
    --bg:#ffffff; --panel:#fafafa; --text:#18181b; --muted:#71717a; --line:#e4e4e7;
    --field:#fff; --accent:#18181b; --accent-fg:#fff; --ring:rgba(0,0,0,.10);
    --ok:#15803d; --ok-bg:#15803d12;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#0c0c0d; --panel:#141416; --text:#ededed; --muted:#8d8d94; --line:#27272a;
    --field:#121214; --accent:#ededed; --accent-fg:#0c0c0d; --ring:rgba(255,255,255,.14);
    --ok:#4ade80; --ok-bg:#4ade8016; } }
  * { box-sizing: border-box; }
  body { font: 14px/1.55 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; margin: 0; background: var(--bg); color: var(--text); padding-bottom: 76px; }
  .topbar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 14px 28px; background: var(--bg); border-bottom: 1px solid var(--line); }
  .brand b { font-size: 15px; font-weight: 650; }
  .brand small { display: block; color: var(--muted); font-size: 11px; font-family: var(--mono); text-transform: uppercase; letter-spacing: .08em; margin-top: 2px; }
  .ready { min-width: 240px; }
  .ready .t { font-size: 11px; font-family: var(--mono); color: var(--muted); margin-bottom: 7px; text-transform: uppercase; letter-spacing: .05em; }
  .progress { height: 4px; background: var(--line); overflow: hidden; }
  .progress > div { height: 100%; background: var(--text); width: 0; transition: width .35s ease; }
  .health { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px 28px; background: var(--panel); border-bottom: 1px solid var(--line); }
  .pill { display: inline-flex; align-items: center; gap: 7px; padding: 5px 11px; border-radius: 6px; font-size: 12.5px; border: 1px solid var(--line); background: var(--bg); color: var(--muted); }
  .pill.ok { color: var(--text); }
  .pill .h { opacity: .7; }
  .dot { width: 7px; height: 7px; border-radius: 50%; border: 1px solid var(--muted); flex: none; }
  .dot.on { background: var(--ok); border-color: var(--ok); }
  .layout { display: grid; grid-template-columns: 256px 1fr; align-items: start; }
  nav { padding: 16px 14px; position: sticky; top: 0; }
  nav button { display: flex; align-items: center; justify-content: space-between; width: 100%; text-align: left; padding: 8px 11px; margin-bottom: 1px; border: 0; border-radius: 6px; background: transparent; color: var(--text); font: inherit; font-size: 13px; cursor: pointer; transition: background .1s; }
  nav button:hover { background: var(--panel); }
  nav button.active { background: var(--accent); color: var(--accent-fg); }
  nav .tag { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: .06em; opacity: .55; }
  main { padding: 26px 28px; }
  .card { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 26px 28px; max-width: 580px; }
  .sec-title { font-size: 16px; font-weight: 650; margin: 0; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
  .sec-hint { color: var(--muted); font-size: 13px; margin: 14px 0 0; }
  label { display: flex; align-items: center; gap: 8px; margin: 20px 0 7px; font-weight: 600; font-size: 13px; }
  .set { color: var(--ok); font-weight: 600; font-size: 11px; font-family: var(--mono); text-transform: uppercase; letter-spacing: .04em; }
  .field { position: relative; }
  input, select { width: 100%; padding: 9px 12px; border: 1px solid var(--line); border-radius: 6px; font: inherit; font-size: 13.5px; background: var(--field); color: inherit; outline: none; transition: border-color .12s, box-shadow .12s; }
  input::placeholder { color: var(--muted); opacity: .6; }
  input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }
  .field.secret input { padding-right: 78px; }
  .reveal { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); border: 0; background: transparent; cursor: pointer; color: var(--muted); font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; padding: 6px; }
  .reveal:hover { color: var(--text); }
  .bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 12px 28px; background: var(--bg); border-top: 1px solid var(--line); display: flex; gap: 16px; align-items: center; }
  .bar button { padding: 9px 20px; border: 0; border-radius: 6px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; font-size: 13.5px; cursor: pointer; }
  .bar button:hover { opacity: .9; }
  #msg { font-size: 13px; color: var(--muted); }
  @media (max-width: 760px) { .layout { grid-template-columns: 1fr; } nav { position: static; display: flex; flex-wrap: wrap; gap: 6px; border-bottom: 1px solid var(--line); } nav button { width: auto; } .topbar { flex-direction: column; align-items: flex-start; gap: 12px; } }
</style></head><body>
  <div class="topbar">
    <div class="brand"><b>Dream Team</b><small>Backoffice</small></div>
    <div class="ready"><div class="t" id="readyText">Carregando</div><div class="progress"><div id="bar"></div></div></div>
  </div>
  <div class="health" id="health"></div>
  <div class="layout">
    <nav id="nav"></nav>
    <main><div class="card" id="main"></div></main>
  </div>
  <div class="bar"><button onclick="save()">Salvar alterações</button><span id="msg"></span></div>
<script>
const groups = ${groupsJson};
const ESSENTIAL = ["Modelos por papel","Chaves de provedor","Sandbox (Dev executa código)","Linear","GitHub"];
let cfg = { fields: {}, health: [] };
let active = 0;

function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderHealth() {
  const h = document.getElementById('health'); h.innerHTML = '';
  for (const c of cfg.health) {
    const el = document.createElement('span');
    el.className = 'pill ' + (c.ready ? 'ok' : '');
    el.innerHTML = '<span class="dot' + (c.ready ? ' on' : '') + '"></span>' + esc(c.name) + (!c.ready && c.hint ? ' <span class="h">· ' + esc(c.hint) + '</span>' : '');
    h.append(el);
  }
  const ready = cfg.health.filter(c => c.ready).length;
  const total = cfg.health.length || 1;
  document.getElementById('bar').style.width = Math.round(ready / total * 100) + '%';
  document.getElementById('readyText').textContent = ready + ' de ' + total + ' capacidades prontas';
}
function renderNav() {
  const nav = document.getElementById('nav'); nav.innerHTML = '';
  groups.forEach((g, i) => {
    const b = document.createElement('button');
    b.className = i === active ? 'active' : '';
    const tag = ESSENTIAL.includes(g.title) ? '<span class="tag">essencial</span>' : '';
    b.innerHTML = '<span>' + esc(g.title) + '</span>' + tag;
    b.onclick = () => { active = i; render(); };
    nav.append(b);
  });
}
function render() {
  renderNav();
  const g = groups[active];
  const m = document.getElementById('main'); m.innerHTML = '';
  const t = document.createElement('div'); t.className = 'sec-title'; t.textContent = g.title; m.append(t);
  if (g.hint) { const p = document.createElement('div'); p.className='sec-hint'; p.textContent = g.hint; m.append(p); }
  for (const field of g.fields) {
    const meta = cfg.fields[field.key] || { set:false, value:'' };
    const lab = document.createElement('label');
    lab.innerHTML = esc(field.label) + ' ' + (meta.set ? '<span class="set">definido</span>' : '');
    m.append(lab);
    if (field.type === 'select') {
      const wrap = document.createElement('div'); wrap.className = 'field';
      const sel = document.createElement('select'); sel.id = 'k_' + field.key;
      for (const opt of (field.options||[])) { const o = document.createElement('option'); o.value=opt; o.textContent=opt; sel.append(o); }
      sel.value = meta.value || (field.options && field.options[0]) || '';
      wrap.append(sel); m.append(wrap);
    } else if (field.type === 'secret') {
      const wrap = document.createElement('div'); wrap.className = 'field secret';
      const inp = document.createElement('input'); inp.id = 'k_' + field.key; inp.type = 'password';
      inp.placeholder = meta.set ? '•••••••• (em branco = manter)' : (field.placeholder || '');
      const tog = document.createElement('button'); tog.type='button'; tog.className='reveal'; tog.textContent='mostrar';
      tog.onclick = () => { const show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; tog.textContent = show ? 'ocultar' : 'mostrar'; };
      wrap.append(inp, tog); m.append(wrap);
    } else {
      const wrap = document.createElement('div'); wrap.className = 'field';
      const inp = document.createElement('input'); inp.id = 'k_' + field.key; inp.type = 'text';
      inp.value = meta.value || ''; inp.placeholder = field.placeholder || '';
      wrap.append(inp); m.append(wrap);
    }
  }
}
async function load() {
  cfg = await fetch('/api/config').then(r => r.json());
  renderHealth(); render();
}
async function save() {
  const updates = {};
  for (const g of groups) for (const field of g.fields) {
    const el = document.getElementById('k_' + field.key);
    if (el && el.value.trim()) updates[field.key] = el.value.trim();
  }
  const r = await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(updates) }).then(r => r.json());
  const msg = document.getElementById('msg');
  if (r.ok) { msg.style.color = 'var(--ok)'; msg.textContent = 'Salvo — ' + r.saved.length + ' campos atualizados'; cfg.health = r.health; cfg = await fetch('/api/config').then(x=>x.json()); renderHealth(); render(); setTimeout(()=>msg.textContent='', 3000); }
  else { msg.style.color = '#dc2626'; msg.textContent = 'Erro: ' + (r.error || 'falha ao salvar'); }
}
load();
</script></body></html>`;
}

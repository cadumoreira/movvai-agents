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
    console.log(`\n  🛠️  Backoffice: abra http://localhost:${port} no navegador\n`);
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
    --bg:#f5f6f8; --surface:#fff; --text:#0f172a; --muted:#64748b; --line:#e6e8ec;
    --input:#fff; --accent:#6366f1; --weak:#6366f114; --ok:#16a34a; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#0b0e14; --surface:#141925; --text:#e6e9ef; --muted:#8b95a7; --line:#222a38;
    --input:#0f141d; --accent:#818cf8; --weak:#818cf81f; --ok:#34d399; } }
  * { box-sizing: border-box; }
  body { font: 14.5px/1.55 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; margin: 0; background: var(--bg); color: var(--text); padding-bottom: 78px; }
  .topbar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 13px 28px; background: var(--surface); border-bottom: 1px solid var(--line); }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 22px; }
  .brand b { font-size: 15px; display: block; line-height: 1.1; } .brand small { color: var(--muted); font-size: 12px; }
  .ready { min-width: 230px; }
  .ready .t { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .progress { height: 6px; background: var(--line); border-radius: 999px; overflow: hidden; }
  .progress > div { height: 100%; background: var(--accent); width: 0; transition: width .35s ease; }
  .health { display: flex; flex-wrap: wrap; gap: 8px; padding: 13px 28px; background: var(--surface); border-bottom: 1px solid var(--line); }
  .pill { padding: 6px 11px; border-radius: 999px; font-size: 12.5px; border: 1px solid var(--line); color: var(--muted); }
  .pill.ok { background: var(--weak); border-color: transparent; color: var(--text); }
  .pill .h { opacity: .75; }
  .layout { display: grid; grid-template-columns: 250px 1fr; align-items: start; }
  nav { padding: 16px 12px; position: sticky; top: 118px; }
  nav button { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 9px 12px; margin-bottom: 2px; border: 0; border-radius: 9px; background: transparent; color: var(--text); font: inherit; font-size: 13.5px; cursor: pointer; transition: background .12s; }
  nav button:hover { background: var(--weak); }
  nav button.active { background: var(--accent); color: #fff; }
  nav .ic { width: 18px; text-align: center; }
  main { padding: 22px 28px; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 24px 26px; max-width: 600px; box-shadow: 0 1px 3px rgba(0,0,0,.05); }
  .sec-title { font-size: 18px; font-weight: 700; margin: 0 0 4px; }
  .sec-hint { color: var(--muted); font-size: 13px; margin: 0 0 6px; }
  label { display: flex; align-items: center; gap: 8px; margin: 18px 0 6px; font-weight: 600; font-size: 13.5px; }
  .set { color: var(--ok); font-weight: 600; font-size: 11px; background: var(--weak); padding: 1px 8px; border-radius: 999px; }
  .field { position: relative; }
  input, select { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; font: inherit; background: var(--input); color: inherit; outline: none; transition: border-color .12s, box-shadow .12s; }
  input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--weak); }
  .field.secret input { padding-right: 42px; }
  .eye { position: absolute; right: 5px; top: 50%; transform: translateY(-50%); border: 0; background: transparent; cursor: pointer; font-size: 15px; padding: 6px; opacity: .65; }
  .eye:hover { opacity: 1; }
  .bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 12px 28px; background: var(--surface); border-top: 1px solid var(--line); display: flex; gap: 16px; align-items: center; }
  .bar button { padding: 10px 22px; border: 0; border-radius: 10px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .bar button:hover { filter: brightness(1.06); }
  #msg { font-weight: 600; font-size: 14px; }
  @media (max-width: 760px) { .layout { grid-template-columns: 1fr; } nav { position: static; top: auto; display: flex; flex-wrap: wrap; gap: 6px; border-bottom: 1px solid var(--line); } nav button { width: auto; } .topbar { flex-direction: column; align-items: flex-start; gap: 12px; } }
</style></head><body>
  <div class="topbar">
    <div class="brand">🤖 <span><b>Dream Team</b><small>Backoffice de configuração</small></span></div>
    <div class="ready"><div class="t" id="readyText">Carregando…</div><div class="progress"><div id="bar"></div></div></div>
  </div>
  <div class="health" id="health"></div>
  <div class="layout">
    <nav id="nav"></nav>
    <main><div class="card" id="main"></div></main>
  </div>
  <div class="bar"><button onclick="save()">💾 Salvar tudo</button><span id="msg"></span></div>
<script>
const groups = ${groupsJson};
const ESSENTIAL = ["Modelos por papel","Chaves de provedor","Sandbox (Dev executa código)","Linear","GitHub"];
const ICON = { "Modelos por papel":"🧠","Chaves de provedor":"🔑","Conselho multi-modelo (opcional)":"⚖️","Sandbox (Dev executa código)":"📦","Linear":"📋","Jira (alternativa ao Linear)":"📋","GitHub":"🐙","Slack":"💬","Automação (webhooks de entrada)":"⚡","Acesso (RBAC) & organização":"🔒","Infra & custo":"⚙️","Observabilidade (OpenTelemetry → Langfuse)":"📈" };
let cfg = { fields: {}, health: [] };
let active = 0;

function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderHealth() {
  const h = document.getElementById('health'); h.innerHTML = '';
  for (const c of cfg.health) {
    const el = document.createElement('span');
    el.className = 'pill ' + (c.ready ? 'ok' : '');
    el.innerHTML = (c.ready ? '✓ ' : '○ ') + esc(c.name) + (!c.ready && c.hint ? ' <span class="h">· ' + esc(c.hint) + '</span>' : '');
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
    const star = ESSENTIAL.includes(g.title) ? ' ⭐' : '';
    b.innerHTML = '<span class="ic">' + (ICON[g.title] || '•') + '</span><span>' + esc(g.title) + star + '</span>';
    b.onclick = () => { active = i; render(); };
    nav.append(b);
  });
}
function render() {
  renderNav();
  const g = groups[active];
  const m = document.getElementById('main'); m.innerHTML = '';
  const t = document.createElement('div'); t.className = 'sec-title'; t.textContent = (ICON[g.title]||'') + ' ' + g.title; m.append(t);
  if (g.hint) { const p = document.createElement('div'); p.className='sec-hint'; p.textContent = g.hint; m.append(p); }
  for (const field of g.fields) {
    const meta = cfg.fields[field.key] || { set:false, value:'' };
    const lab = document.createElement('label');
    lab.innerHTML = esc(field.label) + ' ' + (meta.set ? '<span class="set">✓ definido</span>' : '');
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
      const tog = document.createElement('button'); tog.type='button'; tog.className='eye'; tog.textContent='👁';
      tog.onclick = () => { inp.type = inp.type === 'password' ? 'text' : 'password'; };
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
  if (r.ok) { msg.style.color = '#16a34a'; msg.textContent = '✅ Salvo (' + r.saved.length + ' campos)'; cfg.health = r.health; cfg = await fetch('/api/config').then(x=>x.json()); renderHealth(); render(); setTimeout(()=>msg.textContent='', 3000); }
  else { msg.style.color = '#dc2626'; msg.textContent = '❌ ' + (r.error || 'erro'); }
}
load();
</script></body></html>`;
}

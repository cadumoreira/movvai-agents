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
  :root { color-scheme: light dark; --line:#8884; --muted:#888; --accent:#2563eb; }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 system-ui, sans-serif; margin: 0; padding-bottom: 72px; }
  header { padding: 20px 28px; border-bottom: 1px solid var(--line); }
  header h1 { font-size: 20px; margin: 0 0 4px; }
  header p { margin: 0; color: var(--muted); font-size: 13px; }
  .health { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .pill { padding: 6px 12px; border-radius: 999px; font-size: 13px; border: 1px solid var(--line); cursor: default; }
  .pill.ok { background: #16a34a22; border-color: #16a34a88; }
  .pill .h { color: var(--muted); font-size: 12px; }
  .layout { display: grid; grid-template-columns: 230px 1fr; gap: 0; }
  nav { border-right: 1px solid var(--line); padding: 14px 10px; position: sticky; top: 0; align-self: start; }
  nav button { display: block; width: 100%; text-align: left; padding: 9px 12px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  nav button:hover { background: #80808018; }
  nav button.active { background: var(--accent); color: #fff; }
  main { padding: 24px 28px; max-width: 640px; }
  .sec-title { font-size: 18px; font-weight: 700; margin: 0 0 4px; }
  .sec-hint { color: var(--muted); font-size: 13px; margin: 0 0 18px; }
  label { display: block; margin: 14px 0 5px; font-weight: 600; font-size: 14px; }
  .set { color: #16a34a; font-weight: 600; font-size: 12px; }
  input, select { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; font: inherit; background: transparent; color: inherit; }
  .secret { display: flex; gap: 8px; }
  .secret button { border: 1px solid var(--line); background: transparent; border-radius: 8px; padding: 0 12px; cursor: pointer; color: inherit; }
  .bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 12px 28px; background: Canvas; border-top: 1px solid var(--line); display: flex; gap: 16px; align-items: center; }
  .bar button { padding: 10px 24px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  #msg { font-weight: 600; }
  @media (max-width: 720px) { .layout { grid-template-columns: 1fr; } nav { position: static; border-right: 0; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 6px; } nav button { width: auto; } }
</style></head><body>
  <header>
    <h1>🛠️ Backoffice — Dream Team</h1>
    <p>Configure tudo pela web. Grava no <code>.env</code> local · ✓ = definido · segredos não são exibidos · campos em branco não apagam o que existe.</p>
    <div class="health" id="health"></div>
  </header>
  <div class="layout">
    <nav id="nav"></nav>
    <main id="main"></main>
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
}
function renderNav() {
  const nav = document.getElementById('nav'); nav.innerHTML = '';
  groups.forEach((g, i) => {
    const b = document.createElement('button');
    b.className = i === active ? 'active' : '';
    const star = ESSENTIAL.includes(g.title) ? ' ⭐' : '';
    b.innerHTML = (ICON[g.title] || '•') + ' ' + esc(g.title) + star;
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
      const sel = document.createElement('select'); sel.id = 'k_' + field.key;
      for (const opt of (field.options||[])) { const o = document.createElement('option'); o.value=opt; o.textContent=opt; sel.append(o); }
      sel.value = meta.value || (field.options && field.options[0]) || '';
      m.append(sel);
    } else if (field.type === 'secret') {
      const wrap = document.createElement('div'); wrap.className = 'secret';
      const inp = document.createElement('input'); inp.id = 'k_' + field.key; inp.type = 'password';
      inp.placeholder = meta.set ? '•••••••• (em branco = manter)' : (field.placeholder || '');
      const tog = document.createElement('button'); tog.type='button'; tog.textContent='👁';
      tog.onclick = () => { inp.type = inp.type === 'password' ? 'text' : 'password'; };
      wrap.append(inp, tog); m.append(wrap);
    } else {
      const inp = document.createElement('input'); inp.id = 'k_' + field.key; inp.type = 'text';
      inp.value = meta.value || ''; inp.placeholder = field.placeholder || '';
      m.append(inp);
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

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
    { name: "PM cria tickets", ready: hasModel && hasTickets },
    { name: "Dev abre PR no repo", ready: hasModel && isSet("GITHUB_TOKEN") && sandboxOk },
    { name: "Time completo no Slack", ready: slackOk && hasModel },
    { name: "Conselho multi-modelo", ready: getValue("COUNCIL_MODELS").split(",").filter(Boolean).length >= 2 },
    { name: "Observabilidade", ready: (isSet("LANGFUSE_PUBLIC_KEY") && isSet("LANGFUSE_SECRET_KEY")) || isSet("OTEL_EXPORTER_OTLP_ENDPOINT") },
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
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 760px; margin: 0 auto; padding: 24px 24px 80px; }
  h1 { font-size: 22px; } h2 { font-size: 14px; text-transform: uppercase; color: #888; margin-top: 30px; }
  .hint { color: #888; font-size: 13px; margin: 2px 0 12px; }
  label { display: block; margin: 10px 0 4px; font-weight: 600; font-size: 14px; }
  .set { color: #16a34a; font-weight: 400; font-size: 12px; }
  input, select { width: 100%; padding: 9px 11px; border: 1px solid #8884; border-radius: 8px; font: inherit; box-sizing: border-box; background: transparent; }
  .health { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
  .pill { padding: 6px 12px; border-radius: 999px; font-size: 13px; border: 1px solid #8884; }
  .ok { background: #16a34a22; border-color: #16a34a; }
  .no { background: #80808011; }
  .bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 12px 24px; background: Canvas; border-top: 1px solid #8883; display: flex; gap: 16px; align-items: center; }
  button { padding: 10px 22px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  #msg { font-weight: 600; }
</style></head><body>
  <h1>🛠️ Backoffice — Dream Team</h1>
  <p class="hint">Configure tudo aqui. Grava no <code>.env</code> local (✓ = já definido; segredos não são exibidos; campos em branco não apagam o que existe).</p>
  <div class="health" id="health"></div>
  <form id="f"></form>
  <div class="bar"><button onclick="save()">Salvar tudo</button><span id="msg"></span></div>
<script>
const groups = ${groupsJson};
let cfg = { fields: {}, health: [] };
function renderHealth() {
  const h = document.getElementById('health'); h.innerHTML = '';
  for (const c of cfg.health) {
    const el = document.createElement('span');
    el.className = 'pill ' + (c.ready ? 'ok' : 'no');
    el.textContent = (c.ready ? '✓ ' : '○ ') + c.name;
    h.append(el);
  }
}
async function load() {
  cfg = await fetch('/api/config').then(r => r.json());
  renderHealth();
  const f = document.getElementById('f'); f.innerHTML = '';
  for (const g of groups) {
    const h = document.createElement('h2'); h.textContent = g.title; f.append(h);
    if (g.hint) { const p = document.createElement('div'); p.className='hint'; p.textContent = g.hint; f.append(p); }
    for (const field of g.fields) {
      const meta = cfg.fields[field.key] || { set:false, value:'' };
      const lab = document.createElement('label');
      lab.textContent = field.label + ' ';
      if (meta.set) { const s = document.createElement('span'); s.className='set'; s.textContent='✓'; lab.append(s); }
      let inp;
      if (field.type === 'select') {
        inp = document.createElement('select');
        for (const opt of (field.options||[])) { const o = document.createElement('option'); o.value=opt; o.textContent=opt; inp.append(o); }
        inp.value = meta.value || (field.options && field.options[0]) || '';
      } else {
        inp = document.createElement('input');
        inp.type = field.type === 'secret' ? 'password' : 'text';
        inp.value = field.type === 'secret' ? '' : (meta.value || '');
        inp.placeholder = (field.type === 'secret' && meta.set) ? '•••••••• (em branco = manter)' : (field.placeholder || '');
      }
      inp.id = 'k_' + field.key;
      f.append(lab, inp);
    }
  }
}
async function save() {
  const updates = {};
  for (const g of groups) for (const field of g.fields) {
    const v = document.getElementById('k_' + field.key).value.trim();
    if (v) updates[field.key] = v;
  }
  const r = await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(updates) }).then(r => r.json());
  const msg = document.getElementById('msg');
  if (r.ok) { msg.style.color = '#16a34a'; msg.textContent = '✅ Salvo'; cfg.health = r.health; renderHealth(); load(); setTimeout(()=>msg.textContent='',3000); }
  else { msg.style.color = '#dc2626'; msg.textContent = '❌ ' + (r.error || 'erro'); }
}
load();
</script></body></html>`;
}

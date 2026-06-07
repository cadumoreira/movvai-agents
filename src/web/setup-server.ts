import http from "node:http";
import { isSet, updateEnvFile } from "./env-store.js";

/** Definição de um campo de configuração exibido no front de setup. */
interface Field {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
}

interface Group {
  title: string;
  hint?: string;
  fields: Field[];
}

const GROUPS: Group[] = [
  {
    title: "Modelo (obrigatório p/ qualquer teste)",
    hint: "Preencha pelo menos um provedor. O PM usa Claude por padrão.",
    fields: [
      { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key", secret: true, placeholder: "sk-ant-..." },
      { key: "OPENAI_API_KEY", label: "OpenAI API Key", secret: true, placeholder: "sk-..." },
      { key: "GOOGLE_GENERATIVE_AI_API_KEY", label: "Google Gemini API Key", secret: true },
    ],
  },
  {
    title: "Linear (PM cria tickets)",
    fields: [
      { key: "LINEAR_API_KEY", label: "Linear API Key", secret: true, placeholder: "lin_api_..." },
      { key: "LINEAR_TEAM_KEY", label: "Time (sigla, ex.: ENG)" },
    ],
  },
  {
    title: "GitHub (investigar repo / abrir PR)",
    fields: [
      { key: "GITHUB_TOKEN", label: "GitHub Token (PAT)", secret: true, placeholder: "github_pat_..." },
      { key: "GITHUB_DEFAULT_REPO", label: "Repositório (owner/repo)", placeholder: "cadumoreira/movvai-agents" },
    ],
  },
  {
    title: "Sandbox (Dev executa código)",
    hint: "Deixe 'local' para rodar na sua máquina (sem conta). 'e2b' precisa da chave abaixo.",
    fields: [
      { key: "SANDBOX_PROVIDER", label: "Provider (local | docker | e2b)", placeholder: "local" },
      { key: "E2B_API_KEY", label: "E2B API Key (só se provider=e2b)", secret: true },
    ],
  },
  {
    title: "Slack (time completo — opcional p/ smoke tests)",
    fields: [
      { key: "SLACK_BOT_TOKEN", label: "Bot Token", secret: true, placeholder: "xoxb-..." },
      { key: "SLACK_APP_TOKEN", label: "App Token", secret: true, placeholder: "xapp-..." },
      { key: "SLACK_SIGNING_SECRET", label: "Signing Secret", secret: true },
      { key: "SLACK_DEFAULT_CHANNEL", label: "Canal padrão (ex.: C0123ABC)" },
    ],
  },
];

const ALL_KEYS = GROUPS.flatMap((g) => g.fields.map((f) => f.key));

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
    if (req.method === "GET" && path === "/api/status") {
      const status: Record<string, boolean> = {};
      for (const k of ALL_KEYS) status[k] = isSet(k);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
      return;
    }
    if (req.method === "POST" && path === "/api/keys") {
      const body = await readBody(req);
      let updates: Record<string, string> = {};
      try {
        updates = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "JSON inválido" }));
        return;
      }
      // Só aceita chaves conhecidas.
      const safe: Record<string, string> = {};
      for (const k of ALL_KEYS) if (typeof updates[k] === "string") safe[k] = updates[k];
      updateEnvFile(safe);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, saved: Object.keys(safe).filter((k) => safe[k]) }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(port, () => {
    console.log(`\n  🔧 Configuração: abra http://localhost:${port} no navegador\n`);
  });
}

function page(): string {
  const groupsJson = JSON.stringify(GROUPS);
  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Dream Team — Configuração</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; } h2 { font-size: 14px; text-transform: uppercase; color: #888; margin-top: 28px; }
  .hint { color: #888; font-size: 13px; margin: 4px 0 12px; }
  label { display: block; margin: 10px 0 4px; font-weight: 600; }
  .set { color: #16a34a; font-weight: 400; font-size: 12px; }
  input { width: 100%; padding: 9px 11px; border: 1px solid #8884; border-radius: 8px; font: inherit; box-sizing: border-box; }
  button { margin-top: 24px; padding: 11px 20px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  #msg { margin-top: 14px; font-weight: 600; }
</style></head><body>
  <h1>🔧 Configurar o Dream Team</h1>
  <p class="hint">Cole suas chaves e clique em Salvar. Elas ficam só no arquivo <code>.env</code> da sua máquina.
  Campos em branco não apagam o que já está salvo (✓ = já definido).</p>
  <form id="f"></form>
  <button onclick="save()">Salvar</button>
  <div id="msg"></div>
<script>
const groups = ${groupsJson};
let status = {};
async function load() {
  status = await fetch('/api/status').then(r => r.json());
  const f = document.getElementById('f'); f.innerHTML = '';
  for (const g of groups) {
    const h = document.createElement('h2'); h.textContent = g.title; f.append(h);
    if (g.hint) { const p = document.createElement('div'); p.className='hint'; p.textContent = g.hint; f.append(p); }
    for (const field of g.fields) {
      const lab = document.createElement('label');
      lab.textContent = field.label + ' ';
      if (status[field.key]) { const s = document.createElement('span'); s.className='set'; s.textContent='✓ definido'; lab.append(s); }
      const inp = document.createElement('input');
      inp.id = 'k_' + field.key;
      inp.type = field.secret ? 'password' : 'text';
      inp.placeholder = status[field.key] ? '•••••••• (deixe em branco p/ manter)' : (field.placeholder || '');
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
  const r = await fetch('/api/keys', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(updates) }).then(r => r.json());
  const msg = document.getElementById('msg');
  if (r.ok) { msg.style.color = '#16a34a'; msg.textContent = '✅ Salvo! Agora rode: npm run try:pm -- "tem um bug no reset de senha"'; load(); }
  else { msg.style.color = '#dc2626'; msg.textContent = '❌ ' + (r.error || 'erro'); }
}
load();
</script></body></html>`;
}

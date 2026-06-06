import http from "node:http";
import { listActivity } from "../observability/activity.js";
import { listPending, resolvePending } from "../approvals/registry.js";

/**
 * Painel web leve (HTTP nativo, sem dependências). Mostra atividade recente do time e
 * aprovações pendentes — e deixa você aprovar/recusar fora do Slack. Upgrade futuro:
 * SPA em Next.js consumindo estas mesmas rotas /api.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function startDashboard(port: number): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && path === "/api/activity") {
      return json(res, 200, listActivity());
    }
    if (req.method === "GET" && path === "/api/approvals") {
      return json(res, 200, listPending());
    }
    if (req.method === "POST" && path.startsWith("/api/approvals/")) {
      const id = decodeURIComponent(path.slice("/api/approvals/".length));
      const body = await readBody(req);
      const approved = (() => {
        try {
          return Boolean(JSON.parse(body || "{}").approved);
        } catch {
          return false;
        }
      })();
      const ok = resolvePending(id, { approved });
      return json(res, ok ? 200 : 404, { ok });
    }

    json(res, 404, { error: "not found" });
  });

  server.listen(port, () => {
    console.log(
      JSON.stringify({ level: "info", kind: "dashboard", url: `http://localhost:${port}`, at: new Date().toISOString() }),
    );
  });
}

const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Dream Team — Painel</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 20px; } h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: #888; margin-top: 32px; }
  .card { border: 1px solid #8883; border-radius: 10px; padding: 12px 14px; margin: 8px 0; }
  .row { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
  .muted { color: #888; font-size: 13px; }
  button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid #8884; cursor: pointer; }
  .approve { background: #16a34a; color: #fff; border-color: #16a34a; }
  .reject { background: #dc2626; color: #fff; border-color: #dc2626; }
  .empty { color: #888; font-style: italic; }
</style>
</head>
<body>
  <h1>🤖 Dream Team — Painel</h1>
  <h2>Aprovações pendentes</h2>
  <div id="approvals"></div>
  <h2>Atividade recente</h2>
  <div id="activity"></div>
<script>
async function refresh() {
  const [aps, act] = await Promise.all([
    fetch('/api/approvals').then(r => r.json()),
    fetch('/api/activity').then(r => r.json()),
  ]);
  const ap = document.getElementById('approvals');
  ap.innerHTML = aps.length ? '' : '<div class="empty">Nada pendente.</div>';
  for (const a of aps) {
    const el = document.createElement('div'); el.className = 'card';
    el.innerHTML = '<div>' + escapeHtml(a.text) + '</div><div class="muted">' + a.createdAt + '</div>';
    const actions = document.createElement('div'); actions.className = 'row'; actions.style.marginTop = '10px';
    const yes = document.createElement('button'); yes.className = 'approve'; yes.textContent = '✅ Aprovar';
    const no = document.createElement('button'); no.className = 'reject'; no.textContent = '❌ Recusar';
    yes.onclick = () => decide(a.id, true); no.onclick = () => decide(a.id, false);
    actions.append(yes, no); el.append(actions); ap.append(el);
  }
  const ac = document.getElementById('activity');
  ac.innerHTML = act.length ? '' : '<div class="empty">Sem atividade ainda.</div>';
  for (const e of act) {
    const el = document.createElement('div'); el.className = 'card';
    const cost = e.cost != null ? ' · $' + e.cost : '';
    const cache = e.cacheHitRate != null ? ' · cache ' + Math.round(e.cacheHitRate * 100) + '%' : '';
    el.innerHTML = '<div class="row"><strong>' + escapeHtml(e.agent || e.kind) + '</strong>' +
      '<span class="muted">' + new Date(e.time).toLocaleTimeString() + '</span></div>' +
      '<div class="muted">' + escapeHtml(e.model || '') + cost + cache + '</div>';
    ac.append(el);
  }
}
async function decide(id, approved) {
  await fetch('/api/approvals/' + encodeURIComponent(id), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved }),
  });
  refresh();
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
refresh(); setInterval(refresh, 2000);
</script>
</body>
</html>`;

import http from "node:http";
import { listActivity } from "../observability/activity.js";
import { listBoard, BOARD_COLUMNS, COLUMN_LABELS } from "../board/board.js";
import { listPending, resolvePending } from "../approvals/registry.js";
import { listAudit } from "../audit/log.js";
import { billingSummary } from "../billing/meter.js";
import { dashboardAuthorized } from "../auth/rbac.js";
import { config } from "../config.js";
import { verifyHmacSha256, parseGithubIssue, parseLinearIssue, type InboundTask } from "./webhooks.js";

export type InboundHandler = (source: "github" | "linear", task: InboundTask) => Promise<void>;

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

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function startDashboard(port: number, onInbound?: InboundHandler): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    // ── Webhooks de entrada (event-driven: issue dispara o time) ──────────────
    if (req.method === "POST" && path === "/webhooks/github" && onInbound) {
      const raw = await readBody(req);
      const sig = String(req.headers["x-hub-signature-256"] ?? "");
      if (!verifyHmacSha256(config.github.webhookSecret, raw, sig)) {
        return json(res, 401, { error: "assinatura inválida" });
      }
      const task = parseGithubIssue(
        String(req.headers["x-github-event"] ?? ""),
        safeParse(raw),
        config.webhooks.triggerLabel,
      );
      if (task) await onInbound("github", task);
      return json(res, 202, { ok: true, triggered: Boolean(task) });
    }
    if (req.method === "POST" && path === "/webhooks/linear" && onInbound) {
      const raw = await readBody(req);
      const sig = String(req.headers["linear-signature"] ?? "");
      if (!verifyHmacSha256(config.webhooks.linearSecret, raw, sig)) {
        return json(res, 401, { error: "assinatura inválida" });
      }
      const task = parseLinearIssue(safeParse(raw), config.webhooks.triggerLabel);
      if (task) await onInbound("linear", task);
      return json(res, 202, { ok: true, triggered: Boolean(task) });
    }

    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && path === "/api/board") {
      return json(res, 200, {
        columns: BOARD_COLUMNS.map((id) => ({ id, label: COLUMN_LABELS[id] })),
        cards: listBoard(),
      });
    }
    if (req.method === "GET" && path === "/api/activity") {
      return json(res, 200, listActivity());
    }
    if (req.method === "GET" && path === "/api/approvals") {
      return json(res, 200, listPending());
    }
    if (req.method === "GET" && path === "/api/audit") {
      return json(res, 200, listAudit());
    }
    if (req.method === "GET" && path === "/api/billing") {
      return json(res, 200, billingSummary());
    }
    if (req.method === "POST" && path.startsWith("/api/approvals/")) {
      if (!dashboardAuthorized(req.headers.authorization)) {
        return json(res, 401, { error: "não autorizado" });
      }
      const id = decodeURIComponent(path.slice("/api/approvals/".length));
      const body = await readBody(req);
      const approved = (() => {
        try {
          return Boolean(JSON.parse(body || "{}").approved);
        } catch {
          return false;
        }
      })();
      const ok = resolvePending(id, { approved }, "dashboard");
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
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 20px; } h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: #888; margin-top: 32px; }
  .card { border: 1px solid #8883; border-radius: 10px; padding: 12px 14px; margin: 8px 0; }
  .row { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
  .muted { color: #888; font-size: 13px; }
  button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid #8884; cursor: pointer; }
  .approve { background: #16a34a; color: #fff; border-color: #16a34a; }
  .reject { background: #dc2626; color: #fff; border-color: #dc2626; }
  .empty { color: #888; font-style: italic; }
  /* ── Kanban ─────────────────────────────────────────────────────────── */
  .kanban { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
  @media (max-width: 860px) { .kanban { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .kcol { border: 1px solid #8883; border-radius: 10px; padding: 10px; min-height: 120px; background: #8880801a; }
  .kcol h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #888; margin: 2px 4px 8px; display: flex; justify-content: space-between; }
  .kcard { border: 1px solid #8884; border-left-width: 3px; border-radius: 8px; padding: 8px 10px; margin: 8px 0; font-size: 13px; background: Canvas; }
  .kcard.produto { border-left-color: #2563eb; }
  .kcard.marketing { border-left-color: #9333ea; }
  .kcard .agent { font-weight: 600; }
  .kcard .title { margin: 2px 0; }
  .tag { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 99px; border: 1px solid #8884; color: #888; }
  .tag.ok { color: #16a34a; border-color: #16a34a66; }
  .tag.falha, .tag.recusado { color: #dc2626; border-color: #dc262666; }
  .pulse { display: inline-block; width: 8px; height: 8px; border-radius: 99px; background: #f59e0b; animation: pulse 1.2s infinite; vertical-align: baseline; }
  @keyframes pulse { 50% { opacity: .3; } }
</style>
</head>
<body>
  <h1>🤖 Dream Team — Painel</h1>
  <h2>Board do time (kanban)</h2>
  <div id="board" class="kanban"></div>
  <h2>Custo por organização</h2>
  <div id="billing"></div>
  <h2>Aprovações pendentes</h2>
  <div id="approvals"></div>
  <h2>Atividade recente</h2>
  <div id="activity"></div>
  <h2>Auditoria</h2>
  <div id="audit"></div>
<script>
async function refresh() {
  const [aps, act, aud, bil, board] = await Promise.all([
    fetch('/api/approvals').then(r => r.json()),
    fetch('/api/activity').then(r => r.json()),
    fetch('/api/audit').then(r => r.json()),
    fetch('/api/billing').then(r => r.json()),
    fetch('/api/board').then(r => r.json()),
  ]);
  renderBoard(board);
  const bi = document.getElementById('billing');
  bi.innerHTML = bil.length ? '' : '<div class="empty">Sem consumo ainda.</div>';
  for (const o of bil) {
    const el = document.createElement('div'); el.className = 'card';
    el.innerHTML = '<div class="row"><strong>' + escapeHtml(o.org) + '</strong>' +
      '<span>$' + o.costUSD + '</span></div>' +
      '<div class="muted">' + o.runs + ' execuções · ' + (o.input + o.output) + ' tokens</div>';
    bi.append(el);
  }
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
  const au = document.getElementById('audit');
  au.innerHTML = aud.length ? '' : '<div class="empty">Sem registros.</div>';
  for (const e of aud) {
    const el = document.createElement('div'); el.className = 'card';
    el.innerHTML = '<div class="row"><strong>' + escapeHtml(e.kind) + '</strong>' +
      '<span class="muted">' + new Date(e.time).toLocaleTimeString() + '</span></div>' +
      '<div class="muted">' + escapeHtml(e.actor) + ' · ' + escapeHtml(e.detail || '') + '</div>';
    au.append(el);
  }
}
function dashToken() {
  let t = localStorage.getItem('dashToken');
  if (t === null) { t = prompt('Token do painel (deixe vazio se não houver):') || ''; localStorage.setItem('dashToken', t); }
  return t;
}
async function decide(id, approved) {
  const res = await fetch('/api/approvals/' + encodeURIComponent(id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + dashToken() },
    body: JSON.stringify({ approved }),
  });
  if (res.status === 401) { localStorage.removeItem('dashToken'); alert('Token inválido — tente de novo.'); }
  refresh();
}
function renderBoard(board) {
  const el = document.getElementById('board');
  el.innerHTML = '';
  for (const col of board.columns) {
    const cards = board.cards.filter(c => c.column === col.id);
    const kcol = document.createElement('div'); kcol.className = 'kcol';
    kcol.innerHTML = '<h3><span>' + escapeHtml(col.label) + '</span><span>' + cards.length + '</span></h3>';
    if (!cards.length) kcol.innerHTML += '<div class="empty" style="font-size:12px;margin:4px">—</div>';
    for (const c of cards) {
      const k = document.createElement('div'); k.className = 'kcard ' + c.squad;
      const lastNote = c.notes.length ? c.notes[c.notes.length - 1].text : '';
      const status = c.column === 'concluido'
        ? (c.outcome ? '<span class="tag ' + c.outcome + '">' + c.outcome + '</span>' : '')
        : (c.column === 'fila' ? '' : '<span class="pulse"></span>');
      k.innerHTML =
        '<div class="row"><span class="agent">' + escapeHtml(c.agent) + '</span>' + status + '</div>' +
        '<div class="title">' + escapeHtml(c.title) + '</div>' +
        '<div class="muted">' + escapeHtml(lastNote) + '</div>' +
        '<div class="row" style="margin-top:4px"><span class="tag">' + escapeHtml(c.squad) + '</span>' +
        '<span class="muted">' + new Date(c.updatedAt).toLocaleTimeString() + '</span></div>';
      kcol.append(k);
    }
    el.append(kcol);
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
refresh(); setInterval(refresh, 2000);
</script>
</body>
</html>`;

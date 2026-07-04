import http from "node:http";
import { listActivity } from "../observability/activity.js";
import { listBoard, BOARD_COLUMNS, COLUMN_LABELS } from "../board/board.js";
import { listPending, resolvePending } from "../approvals/registry.js";
import { listQuestions, answerQuestion } from "../approvals/questions.js";
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
    if (req.method === "GET" && path === "/api/questions") {
      return json(res, 200, listQuestions());
    }
    if (req.method === "POST" && path === "/api/questions/answer") {
      if (!dashboardAuthorized(req.headers.authorization)) {
        return json(res, 401, { error: "não autorizado" });
      }
      const body = safeParse(await readBody(req));
      const threadKey = String(body.threadKey ?? "");
      const answer = String(body.answer ?? "").trim();
      if (!threadKey || !answer) return json(res, 400, { error: "threadKey e answer são obrigatórios" });
      const ok = answerQuestion(threadKey, answer, "dashboard");
      return json(res, ok ? 200 : 404, { ok });
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
  /* ── Toolbar (busca + filtro por squad) ─────────────────────────────── */
  .toolbar { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
  .toolbar input[type=search] { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid #8884; min-width: 220px; background: Canvas; color: CanvasText; }
  .chip { font-size: 13px; padding: 4px 10px; border-radius: 99px; border: 1px solid #8884; background: transparent; color: CanvasText; }
  .chip.active { background: CanvasText; color: Canvas; border-color: CanvasText; }
  .kcard { cursor: pointer; }
  .kcard:hover { border-color: #888a; }
  .kactions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
  .kactions button { padding: 3px 10px; font-size: 12px; border-radius: 6px; }
  .kactions input { font: inherit; font-size: 12px; padding: 3px 8px; border-radius: 6px; border: 1px solid #8884; flex: 1; min-width: 120px; background: Canvas; color: CanvasText; }
  /* ── Modal (dossiê do card) ─────────────────────────────────────────── */
  #overlay { position: fixed; inset: 0; background: #0006; display: none; align-items: flex-start; justify-content: center; padding: 40px 16px; z-index: 10; overflow-y: auto; }
  #overlay.open { display: flex; }
  #modal { background: Canvas; color: CanvasText; border: 1px solid #8884; border-radius: 12px; padding: 20px; max-width: 640px; width: 100%; }
  #modal h3 { margin: 0 0 4px; font-size: 17px; }
  .timeline { margin: 12px 0 0; padding: 0; list-style: none; border-left: 2px solid #8884; }
  .timeline li { margin: 0 0 10px 14px; font-size: 13px; position: relative; }
  .timeline li::before { content: ""; position: absolute; left: -19px; top: 6px; width: 8px; height: 8px; border-radius: 99px; background: #888; }
  .timeline .muted { display: block; }
  a { color: inherit; }
</style>
</head>
<body>
  <h1>🤖 Dream Team — Painel</h1>
  <h2>Board do time (kanban)</h2>
  <div class="toolbar">
    <input type="search" id="q" placeholder="Buscar por título ou agente…" />
    <button class="chip active" data-squad="todos">Todos</button>
    <button class="chip" data-squad="produto">Produto</button>
    <button class="chip" data-squad="marketing">Marketing</button>
  </div>
  <div id="board" class="kanban"></div>
  <h2>Custo por organização</h2>
  <div id="billing"></div>
  <h2>Aprovações pendentes</h2>
  <div id="approvals"></div>
  <h2>Perguntas do time</h2>
  <div id="questions"></div>
  <h2>Atividade recente</h2>
  <div id="activity"></div>
  <h2>Auditoria</h2>
  <div id="audit"></div>
  <div id="overlay"><div id="modal"></div></div>
<script>
let state = { board: { columns: [], cards: [] }, approvals: [], questions: [], billing: [], activity: [], audit: [] };
let filterSquad = 'todos', searchQ = '', openCardKey = null;

async function refresh() {
  const [aps, qs, act, aud, bil, board] = await Promise.all([
    fetch('/api/approvals').then(r => r.json()),
    fetch('/api/questions').then(r => r.json()),
    fetch('/api/activity').then(r => r.json()),
    fetch('/api/audit').then(r => r.json()),
    fetch('/api/billing').then(r => r.json()),
    fetch('/api/board').then(r => r.json()),
  ]);
  state = { board, approvals: aps, questions: qs, activity: act, audit: aud, billing: bil };
  render();
}

// ── Helpers ──────────────────────────────────────────────────────────────
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function linkify(s) {
  return escapeHtml(s).replace(/https?:\\/\\/[^\\s<]+/g, u => '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>');
}
function threadKeyOf(cardKey) { const i = cardKey.lastIndexOf(':'); return i === -1 ? cardKey : cardKey.slice(0, i); }
function cardApprovals(c) {
  // Mesma thread pode ter várias frentes aguardando: prefere as aprovações que citam
  // o agente do card; se nenhuma citar, mostra as da thread (não esconder decisão).
  const all = state.approvals.filter(a => a.threadKey === threadKeyOf(c.key));
  const mine = all.filter(a => a.text.includes(c.agent));
  return mine.length ? mine : all;
}
function cardQuestions(c) {
  return state.questions.filter(q => q.threadKey === threadKeyOf(c.key) && (!q.askedBy || q.askedBy === c.agent));
}
function matchesFilter(c) {
  if (filterSquad !== 'todos' && c.squad !== filterSquad) return false;
  if (!searchQ) return true;
  const q = searchQ.toLowerCase();
  return c.title.toLowerCase().includes(q) || c.agent.toLowerCase().includes(q);
}

// ── Ações (mesmos endpoints dos botões clássicos) ────────────────────────
function dashToken() {
  let t = localStorage.getItem('dashToken');
  if (t === null) { t = prompt('Token do painel (deixe vazio se não houver):') || ''; localStorage.setItem('dashToken', t); }
  return t;
}
async function authedPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + dashToken() },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { localStorage.removeItem('dashToken'); alert('Token inválido — tente de novo.'); }
  refresh();
}
const decide = (id, approved) => authedPost('/api/approvals/' + encodeURIComponent(id), { approved });
const sendAnswer = (threadKey, answer) => answer.trim() && authedPost('/api/questions/answer', { threadKey, answer });

// ── Widgets de decisão (usados no card E no dossiê) ──────────────────────
function approvalWidget(a, compact) {
  const box = document.createElement('div'); box.className = 'kactions';
  if (!compact) {
    const txt = document.createElement('div'); txt.className = 'muted'; txt.style.width = '100%';
    txt.innerHTML = linkify(a.text); box.append(txt);
  }
  const yes = document.createElement('button'); yes.className = 'approve'; yes.textContent = '✅ Aprovar';
  const no = document.createElement('button'); no.className = 'reject'; no.textContent = '❌ Recusar';
  yes.onclick = e => { e.stopPropagation(); decide(a.id, true); };
  no.onclick = e => { e.stopPropagation(); decide(a.id, false); };
  box.append(yes, no);
  return box;
}
function questionWidget(q) {
  const box = document.createElement('div'); box.className = 'kactions';
  const label = document.createElement('div'); label.className = 'muted'; label.style.width = '100%';
  label.textContent = '❓ ' + q.question; box.append(label);
  const input = document.createElement('input'); input.placeholder = 'Sua resposta…';
  const send = document.createElement('button'); send.textContent = 'Responder';
  const go = () => sendAnswer(q.threadKey, input.value);
  send.onclick = e => { e.stopPropagation(); go(); };
  input.onclick = e => e.stopPropagation();
  input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') go(); };
  box.append(input, send);
  return box;
}

// ── Kanban ───────────────────────────────────────────────────────────────
function renderBoard() {
  const el = document.getElementById('board');
  el.innerHTML = '';
  for (const col of state.board.columns) {
    const cards = state.board.cards.filter(c => c.column === col.id && matchesFilter(c));
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
      // Decisões inline: aprovar/recusar e responder pergunta sem sair do card.
      if (c.column === 'aprovacao') {
        for (const a of cardApprovals(c)) k.append(approvalWidget(a, true));
        for (const q of cardQuestions(c)) k.append(questionWidget(q));
      }
      k.onclick = () => { openCardKey = c.key; renderModal(); };
      kcol.append(k);
    }
    el.append(kcol);
  }
}

// ── Dossiê do card (modal) ───────────────────────────────────────────────
function renderModal() {
  const overlay = document.getElementById('overlay');
  const modal = document.getElementById('modal');
  const c = openCardKey && state.board.cards.find(x => x.key === openCardKey);
  if (!c) { overlay.className = ''; modal.innerHTML = ''; return; }
  overlay.className = 'open';
  modal.innerHTML = '';

  const head = document.createElement('div'); head.className = 'row';
  const status = c.outcome ? '<span class="tag ' + c.outcome + '">' + c.outcome + '</span>'
    : (c.column === 'fila' ? '<span class="tag">fila</span>' : '<span class="pulse"></span>');
  head.innerHTML = '<h3>' + escapeHtml(c.agent) + '</h3>' + status;
  const close = document.createElement('button'); close.textContent = 'Fechar';
  close.onclick = () => { openCardKey = null; renderModal(); };
  head.append(close);
  modal.append(head);

  const info = document.createElement('div');
  const colLabel = (state.board.columns.find(x => x.id === c.column) || {}).label || c.column;
  info.innerHTML = '<div class="title" style="font-size:15px">' + escapeHtml(c.title) + '</div>' +
    '<div class="muted"><span class="tag">' + escapeHtml(c.squad) + '</span> · ' + escapeHtml(colLabel) +
    ' · criado ' + new Date(c.createdAt).toLocaleString() + ' · atualizado ' + new Date(c.updatedAt).toLocaleString() + '</div>';
  modal.append(info);

  for (const a of cardApprovals(c)) modal.append(approvalWidget(a, false));
  for (const q of cardQuestions(c)) modal.append(questionWidget(q));

  const tl = document.createElement('ul'); tl.className = 'timeline';
  for (const n of c.notes) {
    const li = document.createElement('li');
    li.innerHTML = linkify(n.text) + '<span class="muted">' + new Date(n.time).toLocaleTimeString() + '</span>';
    tl.append(li);
  }
  if (!c.notes.length) tl.innerHTML = '<li class="empty">Sem registros.</li>';
  modal.append(tl);
}
document.getElementById('overlay').onclick = e => { if (e.target.id === 'overlay') { openCardKey = null; renderModal(); } };

// ── Toolbar ──────────────────────────────────────────────────────────────
document.getElementById('q').oninput = e => { searchQ = e.target.value; renderBoard(); };
for (const chip of document.querySelectorAll('.chip')) {
  chip.onclick = () => {
    filterSquad = chip.dataset.squad;
    for (const c of document.querySelectorAll('.chip')) c.className = 'chip' + (c === chip ? ' active' : '');
    renderBoard();
  };
}

// ── Listas clássicas ─────────────────────────────────────────────────────
function renderLists() {
  const bi = document.getElementById('billing');
  bi.innerHTML = state.billing.length ? '' : '<div class="empty">Sem consumo ainda.</div>';
  for (const o of state.billing) {
    const el = document.createElement('div'); el.className = 'card';
    el.innerHTML = '<div class="row"><strong>' + escapeHtml(o.org) + '</strong>' +
      '<span>$' + o.costUSD + '</span></div>' +
      '<div class="muted">' + o.runs + ' execuções · ' + (o.input + o.output) + ' tokens</div>';
    bi.append(el);
  }
  const ap = document.getElementById('approvals');
  ap.innerHTML = state.approvals.length ? '' : '<div class="empty">Nada pendente.</div>';
  for (const a of state.approvals) {
    const el = document.createElement('div'); el.className = 'card';
    el.innerHTML = '<div>' + linkify(a.text) + '</div><div class="muted">' + a.createdAt + '</div>';
    el.append(approvalWidget(a, true));
    ap.append(el);
  }
  const qs = document.getElementById('questions');
  qs.innerHTML = state.questions.length ? '' : '<div class="empty">Nenhuma pergunta aberta.</div>';
  for (const q of state.questions) {
    const el = document.createElement('div'); el.className = 'card';
    el.innerHTML = '<div><strong>' + escapeHtml(q.askedBy) + '</strong></div><div class="muted">' + q.createdAt + '</div>';
    el.append(questionWidget(q));
    qs.append(el);
  }
  const ac = document.getElementById('activity');
  ac.innerHTML = state.activity.length ? '' : '<div class="empty">Sem atividade ainda.</div>';
  for (const e of state.activity) {
    const el = document.createElement('div'); el.className = 'card';
    const cost = e.cost != null ? ' · $' + e.cost : '';
    const cache = e.cacheHitRate != null ? ' · cache ' + Math.round(e.cacheHitRate * 100) + '%' : '';
    el.innerHTML = '<div class="row"><strong>' + escapeHtml(e.agent || e.kind) + '</strong>' +
      '<span class="muted">' + new Date(e.time).toLocaleTimeString() + '</span></div>' +
      '<div class="muted">' + escapeHtml(e.model || '') + cost + cache + '</div>';
    ac.append(el);
  }
  const au = document.getElementById('audit');
  au.innerHTML = state.audit.length ? '' : '<div class="empty">Sem registros.</div>';
  for (const e of state.audit) {
    const el = document.createElement('div'); el.className = 'card';
    el.innerHTML = '<div class="row"><strong>' + escapeHtml(e.kind) + '</strong>' +
      '<span class="muted">' + new Date(e.time).toLocaleTimeString() + '</span></div>' +
      '<div class="muted">' + escapeHtml(e.actor) + ' · ' + escapeHtml(e.detail || '') + '</div>';
    au.append(el);
  }
}

function render() { renderBoard(); renderLists(); renderModal(); }
refresh(); setInterval(refresh, 2000);
</script>
</body>
</html>`;

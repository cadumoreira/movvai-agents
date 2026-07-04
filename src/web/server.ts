import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
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
    // Assets gerados (criativos): servidos do ASSETS_DIR. basename barra path traversal.
    if (req.method === "GET" && path.startsWith("/assets/")) {
      const file = basename(decodeURIComponent(path.slice("/assets/".length)));
      const full = join(config.assets.dir, file);
      if (!file || !existsSync(full)) return json(res, 404, { error: "not found" });
      const type = file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") || file.endsWith(".jpeg") ? "image/jpeg" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=3600" });
      res.end(readFileSync(full));
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
<title>movvai — Dream Team</title>
<style>
  /*
   * Design system do painel — estilo ClickUp: base branca, cards arredondados com
   * sombra suave, colunas transparentes com pill de status colorido, roxo #7B68EE
   * como cor de ação. Cores de squad (tags) validadas na superfície clara:
   *   produto #2563EB · marketing #DB2777 — validate_palette: ALL CHECKS PASS.
   * Status de coluna (semântico): fila cinza · atuação azul · aguardando âmbar · concluído verde.
   */
  :root {
    color-scheme: light;
    --bg: #FAFBFC;
    --surface: #FFFFFF;
    --border: #E9EBF0;
    --border-strong: #D6DAE1;
    --ink: #292D34;
    --ink-2: #656F7D;
    --ink-3: #87909E;
    --brand: #7B68EE;
    --brand-dark: #6C5CE0;
    --produto: #2563EB;
    --marketing: #DB2777;
    --col-fila: #87909E;
    --col-execucao: #4194F6;
    --col-aprovacao: #D97706;
    --col-concluido: #27AE60;
    --ok: #27AE60;
    --err: #E0362C;
    --warn: #D97706;
  }
  * { box-sizing: border-box; }
  body {
    font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--ink);
    margin: 0; padding: 0 0 64px;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 0 24px; }
  /* Topbar clara com marca roxa */
  .brand { background: var(--surface); border-bottom: 1px solid var(--border); }
  .brand .inner { max-width: 1240px; margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; gap: 10px; }
  .brand .mark { width: 24px; height: 24px; border-radius: 7px; background: linear-gradient(135deg, #7B68EE, #A48AF7); }
  .brand h1 { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; margin: 0; color: var(--ink); }
  .brand h1 span { color: var(--ink-3); font-weight: 500; }
  .brand .env { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--brand); background: rgba(123, 104, 238, 0.10); padding: 3px 12px; border-radius: 99px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-3); margin: 34px 0 4px; font-weight: 700; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin: 8px 0; box-shadow: 0 1px 2px rgba(41, 45, 52, 0.04); }
  .row { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
  .muted { color: var(--ink-2); font-size: 12.5px; }
  button { font: inherit; font-weight: 600; font-size: 13px; padding: 6px 14px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--ink); cursor: pointer; transition: all .15s; }
  button:hover { border-color: var(--brand); color: var(--brand); }
  .approve { background: var(--brand); color: #fff; border-color: var(--brand); }
  .approve:hover { background: var(--brand-dark); border-color: var(--brand-dark); color: #fff; }
  .reject { background: var(--surface); color: var(--err); border-color: var(--border-strong); }
  .reject:hover { border-color: var(--err); color: var(--err); }
  .empty { color: var(--ink-3); font-style: italic; font-size: 13px; }
  a { color: var(--brand); text-decoration: none; }
  a:hover { text-decoration: underline; }
  /* ── Board (estilo ClickUp: colunas transparentes, pill de status) ──── */
  .kanban { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-top: 16px; }
  @media (max-width: 900px) { .kanban { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .kcol { padding: 0 2px; min-height: 140px; }
  .kcol h3 { margin: 0 0 10px; display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .colpill { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #fff; padding: 3px 10px; border-radius: 5px; }
  .colpill.fila { background: var(--col-fila); }
  .colpill.execucao { background: var(--col-execucao); }
  .colpill.aprovacao { background: var(--col-aprovacao); }
  .colpill.concluido { background: var(--col-concluido); }
  .count { font-size: 12px; color: var(--ink-3); font-weight: 600; }
  .kcard { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin: 8px 0; font-size: 13px; background: var(--surface); cursor: pointer; box-shadow: 0 1px 2px rgba(41, 45, 52, 0.05); transition: box-shadow .15s, transform .1s; }
  .kcard:hover { box-shadow: 0 4px 14px rgba(41, 45, 52, 0.10); transform: translateY(-1px); }
  .kcard .agent { font-weight: 600; }
  .kcard .title { margin: 3px 0; color: var(--ink-2); }
  .tag { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 9px; border-radius: 99px; border: 1px solid transparent; color: var(--ink-2); background: #F0F1F3; }
  .kcard.produto .tag.squad, .tag.produto { color: var(--produto); background: rgba(37, 99, 235, 0.09); }
  .kcard.marketing .tag.squad, .tag.marketing { color: var(--marketing); background: rgba(219, 39, 119, 0.09); }
  .tag.ok { color: var(--ok); background: rgba(39, 174, 96, 0.10); }
  .tag.falha { color: var(--err); background: rgba(224, 54, 44, 0.09); }
  .tag.recusado { color: var(--warn); background: rgba(217, 119, 6, 0.10); }
  .pulse { display: inline-block; width: 8px; height: 8px; border-radius: 99px; background: var(--col-aprovacao); animation: pulse 1.4s infinite; }
  @keyframes pulse { 50% { opacity: 0.3; } }
  /* ── Toolbar ────────────────────────────────────────────────────────── */
  .toolbar { display: flex; gap: 8px; align-items: center; margin-top: 16px; flex-wrap: wrap; }
  .toolbar input[type=search] { font: inherit; font-size: 13px; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border); min-width: 250px; background: var(--surface); color: var(--ink); outline: none; box-shadow: 0 1px 2px rgba(41, 45, 52, 0.03); }
  .toolbar input[type=search]:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(123, 104, 238, 0.15); }
  .chip { font-size: 12.5px; font-weight: 600; padding: 6px 16px; border-radius: 99px; border: 1px solid var(--border); background: var(--surface); color: var(--ink-2); }
  .chip:hover { border-color: var(--brand); color: var(--brand); }
  .chip.active { background: rgba(123, 104, 238, 0.12); color: var(--brand); border-color: transparent; }
  .kactions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
  .kactions button { padding: 3px 12px; font-size: 12px; border-radius: 6px; }
  .kactions input { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border); flex: 1; min-width: 120px; background: var(--surface); color: var(--ink); outline: none; }
  .kactions input:focus { border-color: var(--brand); }
  /* ── Modal (dossiê) ─────────────────────────────────────────────────── */
  #overlay { position: fixed; inset: 0; background: rgba(41, 45, 52, 0.40); display: none; align-items: flex-start; justify-content: center; padding: 48px 16px; z-index: 10; overflow-y: auto; }
  #overlay.open { display: flex; }
  #modal { background: var(--surface); color: var(--ink); border: 1px solid var(--border); border-radius: 14px; padding: 22px; max-width: 640px; width: 100%; box-shadow: 0 20px 56px rgba(41, 45, 52, 0.22); }
  #modal h3 { margin: 0 0 4px; font-size: 16px; font-weight: 700; }
  .timeline { margin: 14px 0 0; padding: 0; list-style: none; border-left: 2px solid var(--border); }
  .timeline li { margin: 0 0 10px 14px; font-size: 13px; position: relative; }
  .timeline li::before { content: ""; position: absolute; left: -19.5px; top: 6px; width: 7px; height: 7px; border-radius: 99px; background: var(--brand); }
  .timeline .muted { display: block; }
</style>
</head>
<body>
  <div class="brand">
    <div class="inner">
      <div class="mark"></div>
      <h1>movvai <span>· Dream Team</span></h1>
      <span class="env">ao vivo</span>
    </div>
  </div>
  <div class="wrap">
  <h2>Board do time</h2>
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
  </div>
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
  // Mesma thread pode ter várias frentes aguardando: cada card mostra as aprovações
  // que citam o SEU agente; as que não citam ninguém (órfãs) aparecem em todos —
  // melhor decisão visível em card errado do que decisão escondida.
  const tk = threadKeyOf(c.key);
  const all = state.approvals.filter(a => a.threadKey === tk);
  const mine = all.filter(a => a.text.includes(c.agent));
  if (mine.length) return mine;
  const agents = state.board.cards.filter(x => threadKeyOf(x.key) === tk).map(x => x.agent);
  return all.filter(a => !agents.some(name => a.text.includes(name)));
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
  const yes = document.createElement('button'); yes.className = 'approve'; yes.textContent = 'Aprovar';
  const no = document.createElement('button'); no.className = 'reject'; no.textContent = 'Recusar';
  yes.onclick = e => { e.stopPropagation(); decide(a.id, true); };
  no.onclick = e => { e.stopPropagation(); decide(a.id, false); };
  box.append(yes, no);
  return box;
}
function questionWidget(q) {
  const box = document.createElement('div'); box.className = 'kactions';
  const label = document.createElement('div'); label.className = 'muted'; label.style.width = '100%';
  label.textContent = 'Pergunta — ' + q.question; box.append(label);
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
    kcol.innerHTML = '<h3><span class="colpill ' + col.id + '">' + escapeHtml(col.label) + '</span>' +
      '<span class="count">' + cards.length + '</span></h3>';
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
        '<div class="row" style="margin-top:4px"><span class="tag squad">' + escapeHtml(c.squad) + '</span>' +
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
    '<div class="muted"><span class="tag ' + c.squad + '">' + escapeHtml(c.squad) + '</span> · ' + escapeHtml(colLabel) +
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

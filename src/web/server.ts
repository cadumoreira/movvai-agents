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
import { listDocs, readDoc, writeDoc, type DocRef } from "./docs-api.js";
import { getConversation } from "../messaging/conversations.js";

export type InboundHandler = (source: "github" | "linear", task: InboundTask) => Promise<void>;
export type DemandHandler = (
  squad: "produto" | "marketing" | "sdr" | "suporte" | "financeiro",
  text: string,
) => Promise<{ ok: boolean; error?: string }>;
/** Mensagem do humano no chat de uma thread (mesmo pipeline de uma menção no Slack). */
export type ChatHandler = (threadKey: string, text: string) => Promise<{ ok: boolean; error?: string }>;

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

export function startDashboard(
  port: number,
  onInbound?: InboundHandler,
  onDemand?: DemandHandler,
  onChat?: ChatHandler,
): http.Server {
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
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
    // Assets (criativos gerados e arquivos da marca). basename barra path traversal.
    const serveFile = (dir: string, prefix: string): boolean => {
      if (req.method !== "GET" || !path.startsWith(prefix)) return false;
      const file = basename(decodeURIComponent(path.slice(prefix.length)));
      const full = join(dir, file);
      if (!file || !existsSync(full)) {
        json(res, 404, { error: "not found" });
        return true;
      }
      const type = file.endsWith(".png") ? "image/png"
        : file.endsWith(".jpg") || file.endsWith(".jpeg") ? "image/jpeg"
        : file.endsWith(".svg") ? "image/svg+xml"
        : file.endsWith(".webp") ? "image/webp"
        : "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=3600" });
      res.end(readFileSync(full));
      return true;
    };
    if (serveFile(config.assets.dir, "/assets/")) return;
    if (serveFile(join(config.brandDir, "assets"), "/brand-assets/")) return;
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
    // Leituras sensíveis (auditoria, custos, playbooks/marca) também exigem o token
    // quando DASHBOARD_TOKEN está configurado — não são só as escritas que vazam.
    if (req.method === "GET" && path === "/api/audit") {
      if (!dashboardAuthorized(req.headers.authorization)) return json(res, 401, { error: "não autorizado" });
      return json(res, 200, listAudit());
    }
    if (req.method === "GET" && path === "/api/billing") {
      if (!dashboardAuthorized(req.headers.authorization)) return json(res, 401, { error: "não autorizado" });
      return json(res, 200, billingSummary());
    }
    // ── Curadoria: playbooks (skills) e manual da marca pelo painel ─────────
    if (req.method === "GET" && path === "/api/docs") {
      if (!dashboardAuthorized(req.headers.authorization)) return json(res, 401, { error: "não autorizado" });
      return json(res, 200, listDocs());
    }
    if (path === "/api/docs/content") {
      const ref: DocRef = {
        type: url.searchParams.get("type") === "brand" ? "brand" : "skill",
        id: url.searchParams.get("id") ?? "",
      };
      if (req.method === "GET") {
        if (!dashboardAuthorized(req.headers.authorization)) return json(res, 401, { error: "não autorizado" });
        const content = readDoc(ref);
        return content === null ? json(res, 404, { error: "not found" }) : json(res, 200, { content });
      }
      if (req.method === "PUT") {
        if (!dashboardAuthorized(req.headers.authorization)) {
          return json(res, 401, { error: "não autorizado" });
        }
        const body = safeParse(await readBody(req));
        const content = String(body.content ?? "");
        if (!content.trim()) return json(res, 400, { error: "conteúdo vazio" });
        return writeDoc(ref, content) ? json(res, 200, { ok: true }) : json(res, 400, { error: "id inválido" });
      }
    }
    // Nova demanda pelo painel (âncora no canal padrão + squad certo).
    if (req.method === "POST" && path === "/api/demand") {
      if (!dashboardAuthorized(req.headers.authorization)) {
        return json(res, 401, { error: "não autorizado" });
      }
      if (!onDemand) return json(res, 503, { error: "indisponível neste modo (rode npm run dev)" });
      const body = safeParse(await readBody(req));
      const squad = String(body.squad ?? "");
      const text = String(body.text ?? "").trim();
      if (!text || !["produto", "marketing", "sdr", "suporte", "financeiro"].includes(squad)) {
        return json(res, 400, { error: "informe squad válido e texto" });
      }
      const result = await onDemand(squad as Parameters<DemandHandler>[0], text);
      return json(res, result.ok ? 200 : 400, result);
    }
    // Conversa (thread interna): ler o histórico e escrever no chat do card.
    if (path === "/api/conversation") {
      if (req.method === "GET") {
        const threadKey = url.searchParams.get("threadKey") ?? "";
        return json(res, 200, { threadKey, messages: getConversation(threadKey) });
      }
      if (req.method === "POST") {
        if (!dashboardAuthorized(req.headers.authorization)) return json(res, 401, { error: "não autorizado" });
        if (!onChat) return json(res, 503, { error: "chat indisponível neste modo (rode npm run dev)" });
        const body = safeParse(await readBody(req));
        const threadKey = String(body.threadKey ?? "");
        const text = String(body.text ?? "").trim();
        if (!threadKey || !text) return json(res, 400, { error: "threadKey e text são obrigatórios" });
        const result = await onChat(threadKey, text);
        return json(res, result.ok ? 200 : 400, result);
      }
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
  };

  // Rota que estourar não pode derrubar o processo (unhandled rejection) nem
  // deixar a requisição pendurada — vira 500 e o time segue vivo.
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error("Erro no painel:", err);
      if (!res.headersSent) json(res, 500, { error: "erro interno" });
      else res.end();
    });
  });

  server.listen(port, () => {
    console.log(
      JSON.stringify({ level: "info", kind: "dashboard", url: `http://localhost:${port}`, at: new Date().toISOString() }),
    );
  });
  return server;
}

const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>movvai — Dream Team</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>
  /*
   * Design system — app shell estilo ClickUp: sidebar de navegação, views, board
   * com pill de status por coluna, cards flutuantes com avatar por agente, roxo
   * #7B68EE como cor de ação. Tags de squad validadas na superfície clara:
   *   produto #2563EB · marketing #DB2777 — validate_palette: ALL CHECKS PASS.
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
    --operacoes: #0D9488;
    --col-fila: #98A1AC;
    --col-execucao: #4194F6;
    --col-aprovacao: #E8A33D;
    --col-concluido: #2EBD85;
    --ok: #27AE60;
    --err: #E0362C;
    --warn: #D97706;
  }
  body.dark {
    --bg: #131417;
    --surface: #1C1E23;
    --border: #2A2D34;
    --border-strong: #3A3E47;
    --ink: #E8EAED;
    --ink-2: #A8AFBA;
    --ink-3: #6E7683;
  }
  * { box-sizing: border-box; }
  body {
    font: 14px/1.5 'Inter', ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--bg); color: var(--ink); margin: 0;
    -webkit-font-smoothing: antialiased;
  }
  /* ── App shell ──────────────────────────────────────────────────────── */
  .app { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100vh; }
  @media (max-width: 900px) { .app { grid-template-columns: 1fr; } .side { display: none; } }
  .side { background: var(--surface); border-right: 1px solid var(--border); padding: 14px 10px; position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 4px; }
  .ws { display: flex; align-items: center; gap: 10px; padding: 6px 8px 14px; border-bottom: 1px solid var(--border); margin-bottom: 10px; }
  .wmark { width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(135deg, #7B68EE, #A48AF7); color: #fff; font-weight: 800; font-size: 17px; display: flex; align-items: center; justify-content: center; }
  .wname { font-weight: 700; font-size: 14.5px; letter-spacing: -0.01em; }
  .wsub { font-size: 11.5px; color: var(--ink-3); }
  .side nav { display: flex; flex-direction: column; gap: 2px; }
  .side nav a { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; color: var(--ink-2); font-weight: 600; font-size: 13px; cursor: pointer; user-select: none; }
  .side nav a:hover { background: #F3F4F6; color: var(--ink); }
  .side nav a.active { background: rgba(123, 104, 238, 0.10); color: var(--brand); }
  .lchip { width: 22px; height: 22px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #fff; flex: none; }
  .badge { margin-left: auto; background: var(--col-aprovacao); color: #fff; font-size: 10.5px; border-radius: 99px; padding: 0 7px; font-weight: 700; line-height: 17px; }
  .side-foot { margin-top: auto; padding: 10px; font-size: 12px; color: var(--ink-3); display: flex; align-items: center; gap: 7px; }
  .livedot { width: 8px; height: 8px; border-radius: 99px; background: var(--col-concluido); animation: pulse 1.6s infinite; }
  main { padding: 0 28px 64px; min-width: 0; }
  .top { padding: 15px 0; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
  .crumb { font-size: 13px; color: var(--ink-3); }
  .crumb b { color: var(--ink); font-weight: 600; }
  .view.hidden { display: none; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-3); margin: 26px 0 4px; font-weight: 700; }
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
  /* Chat da thread (conversa com o time — funciona sem Slack) */
  .chat { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px; }
  .chat h4 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); font-weight: 700; }
  .chatlog { max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }
  .msg { max-width: 82%; padding: 8px 11px; border-radius: 12px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
  .msg .who { display: block; font-size: 10px; font-weight: 700; opacity: .7; margin-bottom: 2px; }
  .msg.agent { align-self: flex-start; background: var(--bg); border: 1px solid var(--border); }
  .msg.sys { align-self: center; background: transparent; color: var(--ink-3); font-size: 12px; max-width: 100%; text-align: center; padding: 2px; }
  .msg.human { align-self: flex-end; background: var(--brand); color: #fff; }
  .chatbox { display: flex; gap: 8px; margin-top: 10px; }
  .chatbox input { flex: 1; padding: 8px 11px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--ink); font: inherit; font-size: 13px; }
  .chatbox input:focus { outline: none; border-color: var(--brand); }
  a:hover { text-decoration: underline; }
  /* ── Board ──────────────────────────────────────────────────────────── */
  .toolbar { display: flex; gap: 8px; align-items: center; margin: 16px 0 4px; flex-wrap: wrap; position: sticky; top: 0; z-index: 5; background: var(--bg); padding: 8px 0; }
  .toolbar input[type=search] { font: inherit; font-size: 13px; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border); min-width: 250px; background: var(--surface); color: var(--ink); outline: none; box-shadow: 0 1px 2px rgba(41, 45, 52, 0.03); }
  .toolbar input[type=search]:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(123, 104, 238, 0.15); }
  .chip { font-size: 12.5px; font-weight: 600; padding: 6px 16px; border-radius: 99px; border: 1px solid var(--border); background: var(--surface); color: var(--ink-2); }
  .chip:hover { border-color: var(--brand); color: var(--brand); }
  .chip.active { background: rgba(123, 104, 238, 0.12); color: var(--brand); border-color: transparent; }
  .kanban { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-top: 14px; align-items: start; }
  @media (max-width: 1100px) { .kanban { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .kcol h3 { margin: 0 0 10px; display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .kcards { max-height: calc(100vh - 320px); overflow-y: auto; padding: 2px; }
  .stat { cursor: pointer; transition: border-color .15s; }
  .stat:hover { border-color: var(--brand); }
  .stat.active { border-color: var(--brand); box-shadow: 0 0 0 2px rgba(123, 104, 238, 0.15); }
  .demand { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
  .demand input { flex: 1; min-width: 260px; font: inherit; font-size: 13px; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--ink); outline: none; }
  .demand input:focus { border-color: var(--brand); }
  .demand select { font: inherit; font-size: 13px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--ink); }
  .demand button.go { background: var(--brand); color: #fff; border-color: var(--brand); }
  .themebtn { margin-top: 8px; width: 100%; text-align: left; font-size: 12.5px; color: var(--ink-3); background: transparent; border: 1px solid var(--border); }
  .colpill { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #fff; padding: 3px 10px; border-radius: 5px; }
  .colpill.fila { background: var(--col-fila); }
  .colpill.execucao { background: var(--col-execucao); }
  .colpill.aprovacao { background: var(--col-aprovacao); }
  .colpill.concluido { background: var(--col-concluido); }
  .count { font-size: 12px; color: var(--ink-3); font-weight: 600; }
  .kempty { border: 1.5px dashed var(--border-strong); border-radius: 10px; padding: 18px 10px; text-align: center; color: var(--ink-3); font-size: 12px; }
  .kcard { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin: 0 0 10px; font-size: 13px; background: var(--surface); cursor: pointer; box-shadow: 0 1px 3px rgba(41, 45, 52, 0.06); transition: box-shadow .15s, transform .1s; }
  .kcard:hover { box-shadow: 0 5px 16px rgba(41, 45, 52, 0.12); transform: translateY(-1px); }
  .khead { display: flex; align-items: center; gap: 8px; }
  .avatar { width: 24px; height: 24px; border-radius: 99px; color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none; }
  .kcard .agent { font-weight: 600; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kcard .title { margin: 6px 0 2px; color: var(--ink); font-weight: 500; }
  .kcard .note { color: var(--ink-2); font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .kfoot { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .kfoot .muted { margin-left: auto; font-size: 11.5px; }
  .tag { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 9px; border-radius: 99px; border: 1px solid transparent; color: var(--ink-2); background: #F0F1F3; }
  .tag.produto { color: var(--produto); background: rgba(37, 99, 235, 0.09); }
  .tag.marketing { color: var(--marketing); background: rgba(219, 39, 119, 0.09); }
  .tag.operacoes { color: var(--operacoes); background: rgba(13, 148, 136, 0.09); }
  .tag.ok { color: var(--ok); background: rgba(39, 174, 96, 0.10); }
  .tag.falha { color: var(--err); background: rgba(224, 54, 44, 0.09); }
  .tag.recusado { color: var(--warn); background: rgba(217, 119, 6, 0.10); }
  .pulse { display: inline-block; width: 8px; height: 8px; border-radius: 99px; background: var(--col-aprovacao); animation: pulse 1.4s infinite; flex: none; }
  @keyframes pulse { 50% { opacity: 0.3; } }
  .kactions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
  .kactions button { padding: 3px 12px; font-size: 12px; border-radius: 6px; }
  .kactions input { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border); flex: 1; min-width: 110px; background: var(--surface); color: var(--ink); outline: none; }
  .kactions input:focus { border-color: var(--brand); }
  /* ── Modal (dossiê) ─────────────────────────────────────────────────── */
  #overlay { position: fixed; inset: 0; background: rgba(41, 45, 52, 0.40); display: none; align-items: flex-start; justify-content: center; padding: 48px 16px; z-index: 10; overflow-y: auto; }
  #overlay.open { display: flex; }
  #modal { background: var(--surface); color: var(--ink); border: 1px solid var(--border); border-radius: 14px; padding: 22px; max-width: 640px; width: 100%; max-height: 86vh; overflow-y: auto; box-shadow: 0 20px 56px rgba(41, 45, 52, 0.22); }
  #modal h3 { margin: 0; font-size: 16px; font-weight: 700; }
  .timeline { margin: 14px 0 0; padding: 0; list-style: none; border-left: 2px solid var(--border); max-height: 200px; overflow-y: auto; }
  .timeline li { margin: 0 0 10px 14px; font-size: 13px; position: relative; }
  .timeline li::before { content: ""; position: absolute; left: -19.5px; top: 6px; width: 7px; height: 7px; border-radius: 99px; background: var(--brand); }
  .timeline .muted { display: block; }
  /* ── Editor de playbooks ────────────────────────────────────────────── */
  .docs { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 14px; margin-top: 14px; align-items: start; }
  @media (max-width: 900px) { .docs { grid-template-columns: 1fr; } }
  .doclist { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 6px; max-height: 70vh; overflow-y: auto; }
  .doclist a { display: block; padding: 7px 10px; border-radius: 7px; font-size: 13px; color: var(--ink-2); cursor: pointer; }
  .doclist a:hover { background: #F3F4F6; color: var(--ink); }
  .doclist a.active { background: rgba(123, 104, 238, 0.10); color: var(--brand); font-weight: 600; }
  .doceditor textarea { width: 100%; min-height: 60vh; margin-top: 10px; font: 13px/1.6 ui-monospace, "Cascadia Code", Menlo, monospace; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); color: var(--ink); resize: vertical; outline: none; }
  .doceditor textarea:focus { border-color: var(--brand); }
  /* ── Polimento ──────────────────────────────────────────────────────── */
  .navlabel { font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); padding: 4px 10px 6px; }
  .side nav a { position: relative; transition: background .12s, color .12s; }
  .side nav a.active::before { content: ""; position: absolute; left: -10px; top: 7px; bottom: 7px; width: 3px; border-radius: 99px; background: var(--brand); }
  .top { justify-content: space-between; }
  .facepile { display: flex; align-items: center; }
  .facepile .avatar { width: 26px; height: 26px; font-size: 11px; margin-left: -7px; border: 2px solid var(--surface); box-shadow: 0 1px 2px rgba(41,45,52,.10); }
  .facepile .avatar:first-child { margin-left: 0; }
  .stats { display: flex; gap: 12px; margin-top: 18px; flex-wrap: wrap; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 18px; min-width: 158px; flex: 1; max-width: 230px; box-shadow: 0 1px 2px rgba(41, 45, 52, 0.04); }
  .stat .num { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.2; }
  .stat .lbl { font-size: 11px; color: var(--ink-3); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 6px; margin-top: 2px; }
  .dot { width: 8px; height: 8px; border-radius: 99px; display: inline-block; flex: none; }
  .kcard { border-radius: 12px; }
  .kcard.enter { animation: pop .18s ease-out; }
  #modal { animation: pop .18s ease-out; }
  @keyframes pop { from { opacity: 0; transform: translateY(4px); } }
  button:active { transform: scale(0.97); }
  .kempty { padding: 22px 10px; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 99px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-track { background: transparent; }
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="ws">
      <div class="wmark">m</div>
      <div><div class="wname">movvai</div><div class="wsub">Dream Team</div></div>
    </div>
    <div class="navlabel">Visões</div>
    <nav id="nav">
      <a data-view="board" class="active"><span class="lchip" style="background:#7B68EE">B</span> Board</a>
      <a data-view="aprovacoes"><span class="lchip" style="background:#2EBD85">A</span> Aprovações <span class="badge" id="b-aps" hidden></span></a>
      <a data-view="perguntas"><span class="lchip" style="background:#E8A33D">P</span> Perguntas <span class="badge" id="b-qs" hidden></span></a>
      <a data-view="atividade"><span class="lchip" style="background:#4194F6">T</span> Atividade</a>
      <a data-view="custo"><span class="lchip" style="background:#DB2777">C</span> Custo</a>
      <a data-view="auditoria"><span class="lchip" style="background:#98A1AC">L</span> Auditoria</a>
      <a data-view="playbooks"><span class="lchip" style="background:#0EA5E9">✎</span> Playbooks</a>
    </nav>
    <div class="side-foot"><span class="livedot"></span> ao vivo · atualiza a cada 2s</div>
    <button class="themebtn" id="themebtn">🌙 Modo escuro</button>
  </aside>
  <main>
    <header class="top"><span class="crumb">Espaço · <b>Marketing &amp; Produto</b> · <span id="viewtitle">Board</span></span><div class="facepile" id="team" title="Agentes ativos"></div></header>

    <section id="view-board" class="view">
      <div class="demand">
        <input id="dtext" placeholder="Nova demanda… (ex.: campanha de lançamento do plano Pro)" />
        <select id="dsquad">
          <option value="marketing">Marketing (Malu)</option>
          <option value="produto">Produto (Rui)</option>
          <option value="sdr">Vendas (Igor)</option>
          <option value="suporte">Suporte (Lia)</option>
          <option value="financeiro">Financeiro (Otto)</option>
        </select>
        <button class="go" id="dgo">Disparar</button>
      </div>
      <div id="stats" class="stats"></div>
      <div class="toolbar">
        <input type="search" id="q" placeholder="Buscar por título ou agente…" />
        <button class="chip active" data-squad="todos">Todos</button>
        <button class="chip" data-squad="produto">Produto</button>
        <button class="chip" data-squad="marketing">Marketing</button>
        <button class="chip" data-squad="operacoes">Operações</button>
      </div>
      <div id="board" class="kanban"></div>
    </section>

    <section id="view-aprovacoes" class="view hidden">
      <h2>Aprovações pendentes</h2>
      <div id="approvals"></div>
    </section>

    <section id="view-perguntas" class="view hidden">
      <h2>Perguntas do time</h2>
      <div id="questions"></div>
    </section>

    <section id="view-atividade" class="view hidden">
      <h2>Atividade recente</h2>
      <div id="activity"></div>
    </section>

    <section id="view-custo" class="view hidden">
      <h2>Custo por organização</h2>
      <div id="billing"></div>
    </section>

    <section id="view-auditoria" class="view hidden">
      <h2>Auditoria</h2>
      <div id="audit"></div>
    </section>

    <section id="view-playbooks" class="view hidden">
      <h2>Playbooks &amp; manual da marca</h2>
      <p class="muted">Edite o comportamento do time sem tocar em código: os agentes leem estes arquivos ao vivo.</p>
      <div class="docs">
        <div id="doclist" class="doclist"></div>
        <div class="doceditor">
          <div class="row"><strong id="docname" class="muted">Selecione um documento…</strong>
            <button id="docsave" disabled>Salvar</button></div>
          <textarea id="docbody" spellcheck="false" placeholder="Conteúdo em Markdown…"></textarea>
        </div>
      </div>
    </section>
  </main>
</div>
<div id="overlay"><div id="modal"></div></div>
<script>
let state = { board: { columns: [], cards: [] }, approvals: [], questions: [], billing: [], activity: [], audit: [], conversation: null };
let filterSquad = 'todos', searchQ = '', openCardKey = null, onlyColumn = null, chatDraft = '';

// Leitura autenticada: usa o token salvo (sem prompt); 401 vira lista vazia.
const authedGet = (url, fallback) => fetch(url, {
  headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('dashToken') || '') },
}).then(r => r.ok ? r.json() : fallback);

async function refresh() {
  const [aps, qs, act, aud, bil, board] = await Promise.all([
    fetch('/api/approvals').then(r => r.json()),
    fetch('/api/questions').then(r => r.json()),
    fetch('/api/activity').then(r => r.json()),
    authedGet('/api/audit', []),
    authedGet('/api/billing', { total: 0, byAgent: [] }),
    fetch('/api/board').then(r => r.json()),
  ]);
  let conversation = null;
  if (openCardKey) {
    const tk = threadKeyOf(openCardKey);
    const conv = await fetch('/api/conversation?threadKey=' + encodeURIComponent(tk)).then(r => r.json()).catch(() => null);
    conversation = conv && conv.messages ? { threadKey: tk, messages: conv.messages } : { threadKey: tk, messages: [] };
  }
  state = { board, approvals: aps, questions: qs, activity: act, audit: aud, billing: bil, conversation };
  render();
}

// ── Helpers ──────────────────────────────────────────────────────────────
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function linkify(s) {
  return escapeHtml(s).replace(/https?:\\/\\/[^\\s<]+/g, u => '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>');
}
function threadKeyOf(cardKey) { const i = cardKey.lastIndexOf(':'); return i === -1 ? cardKey : cardKey.slice(0, i); }
function cardApprovals(c) {
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
const AVATAR_COLORS = ['#7B68EE', '#4194F6', '#2EBD85', '#DB2777', '#E8A33D', '#0EA5E9', '#F26D6D', '#9F7AEA'];
function avatarColor(name) {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function avatarEl(name, size) {
  const a = document.createElement('span'); a.className = 'avatar';
  if (size) { a.style.width = size + 'px'; a.style.height = size + 'px'; a.style.fontSize = Math.round(size * 0.46) + 'px'; }
  a.style.background = avatarColor(name);
  a.textContent = (name.trim()[0] || '?').toUpperCase();
  return a;
}

// ── Ações ────────────────────────────────────────────────────────────────
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

// ── Widgets de decisão (card E dossiê) ───────────────────────────────────
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
  label.textContent = q.question; box.append(label);
  const input = document.createElement('input'); input.placeholder = 'Sua resposta…';
  const send = document.createElement('button'); send.textContent = 'Responder';
  const go = () => sendAnswer(q.threadKey, input.value);
  send.onclick = e => { e.stopPropagation(); go(); };
  input.onclick = e => e.stopPropagation();
  input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') go(); };
  box.append(input, send);
  return box;
}

// ── Board ────────────────────────────────────────────────────────────────
// ── Board com reconciliação por chave (sem piscar) ─────────────────────────
// Em vez de destruir e recriar o DOM a cada refresh (o que fazia os cards
// "piscarem" e reanimava a entrada), a gente mantém os nós e só atualiza o que
// mudou: card novo entra com animação; card igual nem é tocado (preserva foco).
let boardColsKey = null, boardCols = null;
const cardNodes = {};

// Assinatura do que é VISÍVEL num card: se não muda, o nó não é reconstruído.
function cardSig(c) {
  const lastNote = c.notes.length ? c.notes[c.notes.length - 1].text : '';
  const extra = c.column === 'aprovacao'
    ? cardApprovals(c).map(a => a.id).join(',') + '|' + cardQuestions(c).map(q => q.question).join('|')
    : '';
  return [c.agent, c.title, c.column, c.outcome || '', c.squad, lastNote, c.updatedAt, extra].join('\\u00a6');
}

function fillCard(k, c) {
  const head = document.createElement('div'); head.className = 'khead';
  head.append(avatarEl(c.agent));
  const nm = document.createElement('span'); nm.className = 'agent'; nm.textContent = c.agent; head.append(nm);
  if (c.column === 'concluido') {
    if (c.outcome) { const t = document.createElement('span'); t.className = 'tag ' + c.outcome; t.textContent = c.outcome; head.append(t); }
  } else if (c.column !== 'fila') {
    const p = document.createElement('span'); p.className = 'pulse'; head.append(p);
  }
  k.append(head);
  const title = document.createElement('div'); title.className = 'title'; title.textContent = c.title; k.append(title);
  const lastNote = c.notes.length ? c.notes[c.notes.length - 1].text : '';
  if (lastNote) { const n = document.createElement('div'); n.className = 'note'; n.textContent = lastNote; k.append(n); }
  const foot = document.createElement('div'); foot.className = 'kfoot';
  foot.innerHTML = '<span class="tag ' + c.squad + '">' + escapeHtml(c.squad) + '</span>' +
    '<span class="muted">' + new Date(c.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span>';
  k.append(foot);
  if (c.column === 'aprovacao') {
    for (const a of cardApprovals(c)) k.append(approvalWidget(a, true));
    for (const q of cardQuestions(c)) k.append(questionWidget(q));
  }
}

function buildCard(c) {
  const k = document.createElement('div'); k.className = 'kcard ' + c.squad + ' enter';
  k.onclick = () => { openCardKey = c.key; renderModal(); };
  k.addEventListener('animationend', () => k.classList.remove('enter'), { once: true });
  fillCard(k, c);
  return k;
}

// Cria o esqueleto de colunas UMA vez (recria só se o conjunto de colunas mudar).
function ensureBoardSkeleton() {
  const el = document.getElementById('board');
  const colsKey = state.board.columns.map(c => c.id).join(',');
  if (boardCols && boardColsKey === colsKey) return;
  boardColsKey = colsKey; boardCols = {};
  for (const k in cardNodes) delete cardNodes[k];
  el.innerHTML = '';
  for (const col of state.board.columns) {
    const kcol = document.createElement('div'); kcol.className = 'kcol';
    const h = document.createElement('h3');
    h.innerHTML = '<span class="colpill ' + col.id + '">' + escapeHtml(col.label) + '</span><span class="count">0</span>';
    kcol.append(h);
    const wrap = document.createElement('div'); wrap.className = 'kcards'; kcol.append(wrap);
    el.append(kcol);
    boardCols[col.id] = { kcol, wrap, count: h.querySelector('.count') };
  }
}

function renderBoard() {
  ensureBoardSkeleton();
  document.getElementById('board').style.gridTemplateColumns = onlyColumn ? 'minmax(0, 1fr)' : '';
  const seen = new Set();
  for (const col of state.board.columns) {
    const slot = boardCols[col.id]; if (!slot) continue;
    slot.kcol.style.display = (!onlyColumn || col.id === onlyColumn) ? '' : 'none';
    const cards = state.board.cards.filter(c => c.column === col.id && matchesFilter(c));
    slot.count.textContent = cards.length;
    let empty = slot.wrap.querySelector('.kempty');
    if (!cards.length && !empty) { empty = document.createElement('div'); empty.className = 'kempty'; empty.textContent = 'Sem frentes aqui'; slot.wrap.append(empty); }
    else if (cards.length && empty) empty.remove();
    // Reconcilia por chave, mantendo a ordem desejada (só move/insere o necessário).
    let cursor = slot.wrap.firstChild;
    for (const c of cards) {
      seen.add(c.key);
      let entry = cardNodes[c.key], sig = cardSig(c);
      if (!entry) entry = cardNodes[c.key] = { node: buildCard(c), sig };
      else if (entry.sig !== sig) { entry.node.className = 'kcard ' + c.squad; entry.node.innerHTML = ''; fillCard(entry.node, c); entry.sig = sig; }
      const node = entry.node;
      if (node === cursor) cursor = node.nextSibling;
      else slot.wrap.insertBefore(node, cursor);
    }
  }
  for (const key of Object.keys(cardNodes)) {
    if (!seen.has(key)) { cardNodes[key].node.remove(); delete cardNodes[key]; }
  }
}

// ── Dossiê (modal) ───────────────────────────────────────────────────────
let modalSig = null;
function renderModal() {
  const overlay = document.getElementById('overlay');
  const modal = document.getElementById('modal');
  const c = openCardKey && state.board.cards.find(x => x.key === openCardKey);
  if (!c) { overlay.className = ''; modal.innerHTML = ''; modalSig = null; return; }
  // Só reconstrói o dossiê quando algo muda (senão pisca e perde o foco do chat).
  const conv = state.conversation && state.conversation.threadKey === threadKeyOf(c.key) ? state.conversation.messages.length : 0;
  const sig = c.key + '\\u00a6' + cardSig(c) + '\\u00a6' + conv;
  if (overlay.className === 'open' && modalSig === sig) return;
  modalSig = sig;
  overlay.className = 'open';
  modal.innerHTML = '';

  const head = document.createElement('div'); head.className = 'row';
  const left = document.createElement('div'); left.style.display = 'flex'; left.style.alignItems = 'center'; left.style.gap = '10px';
  left.append(avatarEl(c.agent, 30));
  const h = document.createElement('h3'); h.textContent = c.agent; left.append(h);
  if (c.outcome) { const t = document.createElement('span'); t.className = 'tag ' + c.outcome; t.textContent = c.outcome; left.append(t); }
  else if (c.column !== 'fila' && c.column !== 'concluido') { const p = document.createElement('span'); p.className = 'pulse'; left.append(p); }
  head.append(left);
  const close = document.createElement('button'); close.textContent = 'Fechar';
  close.onclick = () => { openCardKey = null; renderModal(); };
  head.append(close);
  modal.append(head);

  const info = document.createElement('div');
  const colLabel = (state.board.columns.find(x => x.id === c.column) || {}).label || c.column;
  info.innerHTML = '<div class="title" style="font-size:15px;margin-top:10px;font-weight:600">' + escapeHtml(c.title) + '</div>' +
    '<div class="muted" style="margin-top:4px"><span class="tag ' + c.squad + '">' + escapeHtml(c.squad) + '</span> · ' + escapeHtml(colLabel) +
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

  // ── Conversa da thread (chat com o time — funciona sem Slack) ──
  const tk = threadKeyOf(c.key);
  const wasTyping = document.activeElement && document.activeElement.id === 'chatinput';
  const chat = document.createElement('div'); chat.className = 'chat';
  const ch4 = document.createElement('h4'); ch4.textContent = 'Conversa'; chat.append(ch4);
  const log = document.createElement('div'); log.className = 'chatlog';
  const msgs = (state.conversation && state.conversation.threadKey === tk) ? state.conversation.messages : [];
  for (const m of msgs) {
    const el = document.createElement('div');
    const kind = m.human ? 'human' : (m.from === 'sistema' ? 'sys' : 'agent');
    el.className = 'msg ' + kind;
    if (kind !== 'sys') el.innerHTML = '<span class="who">' + escapeHtml(m.human ? 'Você' : m.from) + '</span>' + linkify(m.text);
    else el.innerHTML = linkify(m.text);
    log.append(el);
  }
  if (!msgs.length) { const e = document.createElement('div'); e.className = 'msg sys'; e.textContent = 'Sem mensagens ainda — fale com o time aqui.'; log.append(e); }
  chat.append(log);

  const box = document.createElement('div'); box.className = 'chatbox';
  const input = document.createElement('input'); input.id = 'chatinput';
  input.placeholder = 'Escreva para o time (ex.: "Sofia, deixa mais curto")…';
  input.value = chatDraft;
  input.oninput = () => { chatDraft = input.value; };
  const send = document.createElement('button'); send.className = 'approve'; send.textContent = 'Enviar';
  const doSend = async () => {
    const text = input.value.trim(); if (!text) return;
    send.disabled = true;
    const res = await fetch('/api/conversation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + dashToken() },
      body: JSON.stringify({ threadKey: tk, text }),
    });
    send.disabled = false;
    if (res.status === 401) { localStorage.removeItem('dashToken'); alert('Token inválido — tente de novo.'); return; }
    const data = await res.json().catch(() => ({}));
    if (res.ok) { chatDraft = ''; input.value = ''; refresh(); }
    else { alert(data.error || 'Não foi possível enviar.'); }
  };
  send.onclick = doSend;
  input.onkeydown = e => { if (e.key === 'Enter') doSend(); };
  box.append(input, send);
  chat.append(box);
  modal.append(chat);

  log.scrollTop = log.scrollHeight;
  if (wasTyping) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}
document.getElementById('overlay').onclick = e => { if (e.target.id === 'overlay') { openCardKey = null; renderModal(); } };

// ── Navegação (views) ────────────────────────────────────────────────────
const VIEW_TITLES = { board: 'Board', aprovacoes: 'Aprovações', perguntas: 'Perguntas', atividade: 'Atividade', custo: 'Custo', auditoria: 'Auditoria', playbooks: 'Playbooks' };
for (const item of document.querySelectorAll('#nav a')) {
  item.onclick = () => {
    for (const i of document.querySelectorAll('#nav a')) i.classList.toggle('active', i === item);
    for (const v of document.querySelectorAll('.view')) v.classList.add('hidden');
    document.getElementById('view-' + item.dataset.view).classList.remove('hidden');
    document.getElementById('viewtitle').textContent = VIEW_TITLES[item.dataset.view];
  };
}

// ── Toolbar ──────────────────────────────────────────────────────────────
document.getElementById('q').oninput = e => { searchQ = e.target.value; renderBoard(); };
for (const chip of document.querySelectorAll('.chip')) {
  chip.onclick = () => {
    filterSquad = chip.dataset.squad;
    for (const c of document.querySelectorAll('.chip')) c.className = 'chip' + (c === chip ? ' active' : '');
    renderBoard();
  };
}

// ── Listas das views ─────────────────────────────────────────────────────
function renderLists() {
  const bAps = document.getElementById('b-aps');
  bAps.hidden = !state.approvals.length; bAps.textContent = state.approvals.length;
  const bQs = document.getElementById('b-qs');
  bQs.hidden = !state.questions.length; bQs.textContent = state.questions.length;

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
    el.innerHTML = '<div>' + linkify(a.text) + '</div><div class="muted">' + new Date(a.createdAt).toLocaleString() + '</div>';
    el.append(approvalWidget(a, true));
    ap.append(el);
  }
  const qs = document.getElementById('questions');
  qs.innerHTML = state.questions.length ? '' : '<div class="empty">Nenhuma pergunta aberta.</div>';
  for (const q of state.questions) {
    const el = document.createElement('div'); el.className = 'card';
    const head = document.createElement('div'); head.className = 'khead';
    head.append(avatarEl(q.askedBy || '?'));
    const nm = document.createElement('strong'); nm.textContent = q.askedBy; head.append(nm);
    el.append(head);
    const when = document.createElement('div'); when.className = 'muted'; when.textContent = new Date(q.createdAt).toLocaleString();
    el.append(when);
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

function renderStats() {
  const cards = state.board.cards;
  const count = col => cards.filter(c => c.column === col).length;
  const today = new Date().toDateString();
  const doneToday = cards.filter(c => c.column === 'concluido' && new Date(c.updatedAt).toDateString() === today).length;
  const tiles = [
    { n: count('execucao'), l: 'Em atuação', c: 'var(--col-execucao)' },
    { n: count('aprovacao'), l: 'Aguardando você', c: 'var(--col-aprovacao)' },
    { n: doneToday, l: 'Concluídas hoje', c: 'var(--col-concluido)' },
    { n: count('fila'), l: 'Na fila', c: 'var(--col-fila)' },
  ];
  const cols = ['execucao', 'aprovacao', 'concluido', 'fila'];
  document.getElementById('stats').innerHTML = tiles.map((t, i) =>
    '<div class="stat' + (onlyColumn === cols[i] ? ' active' : '') + '" data-col="' + cols[i] + '"><div class="num">' + t.n + '</div>' +
    '<div class="lbl"><span class="dot" style="background:' + t.c + '"></span>' + t.l + '</div></div>').join('');
  for (const el of document.querySelectorAll('.stat')) {
    el.onclick = () => { onlyColumn = onlyColumn === el.dataset.col ? null : el.dataset.col; renderBoard(); renderStats(); };
  }
}
function renderTeam() {
  const seen = [];
  for (const c of state.board.cards) if (!seen.includes(c.agent)) seen.push(c.agent);
  const el = document.getElementById('team');
  el.innerHTML = '';
  for (const name of seen.slice(0, 8)) { const a = avatarEl(name); a.title = name; el.append(a); }
}

// ── Editor de playbooks/marca ───────────────────────────────────────────
let currentDoc = null, docsLoaded = false;
async function loadDocs() {
  const docs = await authedGet('/api/docs', []);
  const list = document.getElementById('doclist');
  list.innerHTML = '';
  for (const d of docs) {
    const a = document.createElement('a');
    a.textContent = d.title;
    a.onclick = async () => {
      const res = await authedGet('/api/docs/content?type=' + d.type + '&id=' + encodeURIComponent(d.id), { content: '' });
      currentDoc = d;
      document.getElementById('docname').textContent = d.title;
      document.getElementById('docbody').value = res.content || '';
      document.getElementById('docsave').disabled = false;
      for (const x of list.children) x.className = x === a ? 'active' : '';
    };
    list.append(a);
  }
  docsLoaded = true;
}
document.getElementById('docsave').onclick = async () => {
  if (!currentDoc) return;
  const res = await fetch('/api/docs/content?type=' + currentDoc.type + '&id=' + encodeURIComponent(currentDoc.id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + dashToken() },
    body: JSON.stringify({ content: document.getElementById('docbody').value }),
  });
  if (res.status === 401) { localStorage.removeItem('dashToken'); alert('Token inválido — tente de novo.'); return; }
  const btn = document.getElementById('docsave');
  btn.textContent = res.ok ? 'Salvo ✓' : 'Erro ao salvar';
  setTimeout(() => { btn.textContent = 'Salvar'; }, 1600);
};

// ── Tema claro/escuro (persistido) ───────────────────────────────────────
function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  document.getElementById('themebtn').textContent = dark ? '☀️ Modo claro' : '🌙 Modo escuro';
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}
document.getElementById('themebtn').onclick = () => applyTheme(!document.body.classList.contains('dark'));
applyTheme(localStorage.getItem('theme') === 'dark');

// ── Nova demanda pelo painel ─────────────────────────────────────────────
document.getElementById('dgo').onclick = async () => {
  const text = document.getElementById('dtext').value.trim();
  if (!text) return;
  const res = await fetch('/api/demand', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + dashToken() },
    body: JSON.stringify({ squad: document.getElementById('dsquad').value, text }),
  });
  const data = await res.json().catch(() => ({}));
  const btn = document.getElementById('dgo');
  if (res.ok) { document.getElementById('dtext').value = ''; btn.textContent = 'Disparado ✓'; }
  else { btn.textContent = data.error ? data.error.slice(0, 40) : 'Erro'; }
  setTimeout(() => { btn.textContent = 'Disparar'; }, 2200);
  refresh();
};
document.getElementById('dtext').onkeydown = e => { if (e.key === 'Enter') document.getElementById('dgo').click(); };

function render() { renderBoard(); renderLists(); renderStats(); renderTeam(); renderModal(); if (!docsLoaded) loadDocs(); }
refresh(); setInterval(refresh, 2000);
</script>
</body>
</html>`;

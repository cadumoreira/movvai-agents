import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Armazém de ENTREGÁVEIS em arquivo: quando um agente produz um documento, ele é gravado
 * em disco e servido pelo painel para download — um anexo de verdade, não texto no card.
 * MVP em disco local (dev); em produção trocar por object storage sem mudar a interface.
 */

const DIR = process.env.ARTIFACTS_DIR || join(process.cwd(), "artifacts");
const SAFE_ID = /^[a-z0-9-]+$/;
let counter = 0;

export interface SavedArtifact {
  id: string;
  filename: string;
  /** URL relativa de download (servida pelo painel). */
  url: string;
  path: string;
}

/** Sanitiza um nome de arquivo (sem barras, sem espaços exóticos). */
function safeName(name: string): string {
  return (name || "documento").replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").slice(0, 80) || "documento";
}

/**
 * Gera um id único e NÃO-ADIVINHÁVEL: timestamp+counter garantem unicidade dentro do
 * processo; os bytes aleatórios tornam o id impossível de enumerar por timestamp (a URL
 * de download é pública, como os outros assets — o id secreto é a proteção).
 */
function nextId(): string {
  counter = (counter + 1) % 100000;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${randomBytes(6).toString("hex")}`;
}

/** Grava um artefato e devolve a URL de download. */
export function saveArtifact(name: string, content: string | Buffer): SavedArtifact {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const id = nextId();
  const filename = safeName(name);
  const path = join(DIR, `${id}__${filename}`);
  writeFileSync(path, content);
  return { id, filename, url: `/artifacts/${id}`, path };
}

/** Recupera um artefato pelo id (para o painel servir). Null se não existir/id inválido. */
export function getArtifact(id: string): { filename: string; body: Buffer } | null {
  if (!SAFE_ID.test(id) || !existsSync(DIR)) return null;
  const match = readdirSync(DIR).find((f) => f.startsWith(`${id}__`));
  if (!match) return null;
  return { filename: match.slice(id.length + 2), body: readFileSync(join(DIR, match)) };
}

/** Converte Markdown simples em HTML abrível pelo Word (.doc). */
export function markdownToWordHtml(title: string, md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inline(esc(h[2]))}</h${h[1].length}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(esc(line.replace(/^\s*[-*]\s+/, "")))}</li>`);
    } else if (line === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(esc(line))}</p>`);
    }
  }
  closeList();
  return (
    `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">` +
    `<head><meta charset="utf-8"><title>${esc(title)}</title></head>` +
    `<body style="font-family:Calibri,Arial,sans-serif;max-width:720px">` +
    `<h1>${esc(title)}</h1>${out.join("\n")}</body></html>`
  );
}

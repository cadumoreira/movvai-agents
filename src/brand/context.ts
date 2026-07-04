import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { config } from "../config.js";
import { parseFrontmatter } from "../tools/skills.js";
import { audit } from "../audit/log.js";
import type { Approver } from "../approvals/gate.js";

/**
 * Brand Center — a fonte de verdade da EMPRESA, presente em todo fluxo:
 *
 *   brand/perfil.md    → perfil compacto (quem somos, produto, tom, público) —
 *                        INJETADO no system prompt de TODOS os agentes (ambiente).
 *   brand/*.md         → documentos profundos (brand book, personas, catálogo…) —
 *                        carregados SOB DEMANDA via read_brand_doc (como as skills).
 *   brand/assets/*     → arquivos da marca (logo, templates) — servidos pelo painel
 *                        em /brand-assets/... para criativos e automações.
 *
 * Tudo Markdown/arquivos editáveis sem redeploy (lidos do disco a cada uso).
 */

const PROFILE_FILE = "perfil.md";
/** Teto do perfil injetado (guarda de custo — com prompt caching fica barato). */
const PROFILE_CAP = 6000;

function root(baseDir?: string): string {
  return baseDir ?? config.brandDir;
}

/** Perfil compacto da marca (corpo do brand/perfil.md), ou null se não existir. */
export function brandProfile(baseDir?: string): string | null {
  const path = join(root(baseDir), PROFILE_FILE);
  if (!existsSync(path)) return null;
  try {
    const body = parseFrontmatter(readFileSync(path, "utf-8")).body.trim();
    return body ? body.slice(0, PROFILE_CAP) : null;
  } catch {
    return null;
  }
}

/**
 * Bloco de system prompt com o contexto da marca — anexado a TODOS os agentes.
 * Vazio se o perfil não estiver configurado (prompt continua honesto).
 */
export function brandPromptBlock(baseDir?: string): string {
  const profile = brandProfile(baseDir);
  if (!profile) return "";
  return `

## Contexto da marca/empresa (fonte de verdade — siga SEMPRE)
${profile}

Este contexto prevalece sobre suposições suas. Detalhes além dele: use \`read_brand_doc\`
(se disponível) ou pergunte — nunca invente fatos sobre a empresa, produto ou marca.`;
}

export interface BrandDocMeta {
  id: string;
  name: string;
  description: string;
}

/** Índice dos documentos profundos (brand/*.md, exceto o perfil). */
export function listBrandDocs(baseDir?: string): BrandDocMeta[] {
  const dir = root(baseDir);
  if (!existsSync(dir)) return [];
  const out: BrandDocMeta[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".md") || file === PROFILE_FILE) continue;
    try {
      const { meta, body } = parseFrontmatter(readFileSync(join(dir, file), "utf-8"));
      const firstLine = body.split("\n").find((l) => l.trim()) ?? "";
      out.push({
        id: basename(file, ".md"),
        name: meta.name || basename(file, ".md"),
        description: meta.description || firstLine.slice(0, 120),
      });
    } catch {
      /* ilegível: ignora */
    }
  }
  return out;
}

const SAFE_ID = /^[a-z0-9._-]+$/i;

/** Conteúdo completo de um documento da marca (por id; sem path traversal). */
export function readBrandDoc(id: string, baseDir?: string): string | null {
  if (!SAFE_ID.test(id)) return null;
  const path = join(root(baseDir), `${id}.md`);
  if (!existsSync(path)) return null;
  try {
    return parseFrontmatter(readFileSync(path, "utf-8")).body;
  } catch {
    return null;
  }
}

/** Assets físicos da marca (logo, templates) com URL pública via painel. */
export function listBrandAssets(baseDir?: string): Array<{ filename: string; url: string }> {
  const dir = join(root(baseDir), "assets");
  if (!existsSync(dir)) return [];
  const base = (config.assets.publicBaseUrl || `http://localhost:${config.dashboard.port}`).replace(/\/$/, "");
  return readdirSync(dir)
    .filter((f) => !f.startsWith(".") && !f.endsWith(".md"))
    .sort()
    .map((filename) => ({ filename, url: `${base}/brand-assets/${filename}` }));
}

/** Grava um documento da marca (id seguro; cria a pasta se preciso). */
export function writeBrandDoc(id: string, content: string, baseDir?: string): boolean {
  if (!SAFE_ID.test(id)) return false;
  const dir = root(baseDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), content);
  return true;
}

/**
 * Autoria do Brand Center (Malu): escrever aqui governa TODOS os agentes, então cada
 * gravação passa pelo portão de aprovação humana — como abrir PR ou publicar.
 */
export function brandAuthoringTools(approve: Approver, actor: string): ToolSet {
  return {
    write_brand_doc: tool({
      description:
        "Grava/atualiza um documento do manual da marca (perfil, brand-book, personas, produto…). " +
        "IMPACTO ALTO: este conteúdo passa a orientar TODOS os agentes — a gravação exige aprovação " +
        "humana (o conteúdo completo é mostrado para o humano decidir). Um documento por chamada.",
      inputSchema: z.object({
        id: z
          .string()
          .describe('Nome do documento sem extensão: "perfil", "brand-book", "personas", "produto"…'),
        content_markdown: z
          .string()
          .describe("Conteúdo COMPLETO do documento em Markdown (substitui o existente)."),
        summary: z.string().describe("1-2 linhas: o que este documento define/muda."),
      }),
      execute: async ({ id, content_markdown, summary }) => {
        if (!SAFE_ID.test(id)) return { ok: false, error: `Id inválido: "${id}".` };
        const exists = readBrandDoc(id) !== null || (id === "perfil" && brandProfile() !== null);
        const decision = await approve({
          text:
            `:closed_book: *Manual da marca* — gravar \`brand/${id}.md\` (${exists ? "SUBSTITUI o existente" : "novo"}).\n` +
            `${summary}\n\n\`\`\`\n${content_markdown.slice(0, 2500)}${content_markdown.length > 2500 ? "\n… (cortado na prévia)" : ""}\n\`\`\``,
        });
        if (!decision.approved) {
          return { ok: false, error: "Gravação recusada pelo humano. Ajuste conforme o feedback e tente de novo." };
        }
        writeBrandDoc(id, content_markdown);
        audit({ kind: "brand_doc_written", actor, detail: `brand/${id}.md`, meta: { summary } });
        return { ok: true, id, note: "Gravado — todos os agentes já passam a usar (leitura é ao vivo)." };
      },
    }),
  };
}

/** Ferramentas de consulta à marca (para quem produz material). */
export function brandTools(): ToolSet {
  if (!existsSync(root())) return {};
  return {
    list_brand_docs: tool({
      description:
        "Lista os documentos profundos da marca (brand book, personas, catálogo, preços…). " +
        "Consulte antes de produzir material; carregue só o relevante com read_brand_doc.",
      inputSchema: z.object({}),
      execute: async () => ({ docs: listBrandDocs() }),
    }),

    read_brand_doc: tool({
      description: "Carrega o conteúdo completo de um documento da marca (pelo id de list_brand_docs).",
      inputSchema: z.object({
        id: z.string().describe('Id do documento (ex.: "brand-book", "personas").'),
      }),
      execute: async ({ id }) => {
        const content = readBrandDoc(id);
        return content === null ? { ok: false, error: `Documento "${id}" não encontrado.` } : { ok: true, content };
      },
    }),

    list_brand_assets: tool({
      description:
        "Lista os ARQUIVOS da marca (logo, templates, imagens) com URL — use a URL do logo/template " +
        "ao montar criativos e ao enviar posts para a automação de publicação.",
      inputSchema: z.object({}),
      execute: async () => ({ assets: listBrandAssets() }),
    }),
  };
}

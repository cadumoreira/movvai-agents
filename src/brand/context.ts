import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { config } from "../config.js";
import { parseFrontmatter } from "../tools/skills.js";

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

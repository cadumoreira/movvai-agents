import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { config } from "../config.js";
import { audit } from "../audit/log.js";

/**
 * Ferramentas do Notion — o "board" do squad de marketing (briefs, calendário editorial,
 * rascunhos). Ativadas só se NOTION_API_KEY estiver configurada. Usa a REST API oficial
 * (sem SDK), mesmo padrão do conector Jira.
 *
 * Onde as páginas nascem (agnóstico do schema do workspace):
 * - NOTION_DATABASE_ID → cria itens no database (descobre a propriedade de título em runtime);
 * - NOTION_PARENT_PAGE_ID → cria subpáginas de uma página-mãe (não exige database);
 * - a ferramenta também aceita um parent_page_id explícito (ex.: rascunho dentro do brief).
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/** Limite da API: cada rich_text.text.content aceita no máximo 2000 caracteres. */
const TEXT_LIMIT = 2000;
/** Limite da API: no máximo 100 blocos por requisição (create/append). */
const BLOCK_LIMIT = 100;

type RichText = { type: "text"; text: { content: string } };
export type NotionBlock = {
  object: "block";
  type: string;
  [key: string]: unknown;
};

/** Quebra um texto em pedaços de até 2000 chars (limite de rich_text da API). */
export function toRichText(text: string): RichText[] {
  const chunks: RichText[] = [];
  for (let i = 0; i < text.length; i += TEXT_LIMIT) {
    chunks.push({ type: "text", text: { content: text.slice(i, i + TEXT_LIMIT) } });
  }
  return chunks.length ? chunks : [{ type: "text", text: { content: "" } }];
}

/**
 * Converte Markdown simples (headings, listas, parágrafos) em blocos do Notion.
 * Determinístico e sem dependências — o suficiente para briefs/rascunhos dos agentes.
 */
export function markdownToBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    let type = "paragraph";
    let text = line;
    if (line.startsWith("### ")) {
      type = "heading_3";
      text = line.slice(4);
    } else if (line.startsWith("## ")) {
      type = "heading_2";
      text = line.slice(3);
    } else if (line.startsWith("# ")) {
      type = "heading_1";
      text = line.slice(2);
    } else if (/^[-*] /.test(line)) {
      type = "bulleted_list_item";
      text = line.slice(2);
    } else if (/^\d+\. /.test(line)) {
      type = "numbered_list_item";
      text = line.replace(/^\d+\. /, "");
    }
    blocks.push({ object: "block", type, [type]: { rich_text: toRichText(text) } });
  }
  return blocks;
}

/** Extrai o título de uma página retornada pela API (procura a propriedade type=title). */
function pageTitle(page: { properties?: Record<string, { type?: string; title?: Array<{ plain_text?: string }> }> }): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop.type === "title") return (prop.title ?? []).map((t) => t.plain_text ?? "").join("");
  }
  return "(sem título)";
}

export function notionTools(actor = "marketing"): ToolSet {
  const { apiKey, databaseId, parentPageId } = config.notion;
  if (!apiKey) return {};

  const headers = {
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION,
    Authorization: `Bearer ${apiKey}`,
  };

  async function api(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${NOTION_API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Nome da propriedade de título do database (todo database tem exatamente uma). */
  let titleProp: string | undefined;
  async function resolveTitleProp(): Promise<string> {
    if (titleProp) return titleProp;
    const res = await api("GET", `/databases/${databaseId}`);
    if (!res.ok) throw new Error(`Falha ao ler o database do Notion (${res.status}).`);
    const data = (await res.json()) as { properties?: Record<string, { type?: string }> };
    const found = Object.entries(data.properties ?? {}).find(([, p]) => p.type === "title")?.[0];
    if (!found) throw new Error("Database do Notion sem propriedade de título.");
    titleProp = found;
    return found;
  }

  /** Anexa blocos a uma página respeitando o limite de 100 por requisição. */
  async function appendBlocks(pageId: string, blocks: NotionBlock[]): Promise<void> {
    for (let i = 0; i < blocks.length; i += BLOCK_LIMIT) {
      const res = await api("PATCH", `/blocks/${pageId}/children`, {
        children: blocks.slice(i, i + BLOCK_LIMIT),
      });
      if (!res.ok) throw new Error(`Falha ao escrever conteúdo no Notion (${res.status}).`);
    }
  }

  return {
    notion_create_page: tool({
      description:
        "Cria uma página no Notion (brief, rascunho de post/artigo, plano de campanha, relatório). " +
        "Sem parent_page_id, cria no espaço padrão do marketing (database ou página-mãe configurada). " +
        "Passe parent_page_id para criar um entregável DENTRO do brief.",
      inputSchema: z.object({
        title: z.string().describe("Título curto e claro da página."),
        content_markdown: z
          .string()
          .describe("Conteúdo em Markdown simples: headings (#), listas (-) e parágrafos."),
        parent_page_id: z
          .string()
          .optional()
          .describe("ID de uma página existente para criar como subpágina (ex.: dentro do brief)."),
      }),
      execute: async ({ title, content_markdown, parent_page_id }) => {
        const blocks = markdownToBlocks(content_markdown);
        let parent: Record<string, string>;
        let properties: Record<string, unknown>;
        if (parent_page_id) {
          parent = { page_id: parent_page_id };
          properties = { title: { title: toRichText(title) } };
        } else if (databaseId) {
          parent = { database_id: databaseId };
          properties = { [await resolveTitleProp()]: { title: toRichText(title) } };
        } else if (parentPageId) {
          parent = { page_id: parentPageId };
          properties = { title: { title: toRichText(title) } };
        } else {
          return {
            ok: false,
            error: "Configure NOTION_DATABASE_ID ou NOTION_PARENT_PAGE_ID (onde as páginas nascem).",
          };
        }

        const res = await api("POST", "/pages", {
          parent,
          properties,
          children: blocks.slice(0, BLOCK_LIMIT),
        });
        if (!res.ok) return { ok: false, error: `Falha ao criar página no Notion (${res.status}).` };
        const page = (await res.json()) as { id: string; url?: string };
        if (blocks.length > BLOCK_LIMIT) await appendBlocks(page.id, blocks.slice(BLOCK_LIMIT));
        audit({ kind: "notion_page_created", actor, detail: title, meta: { url: page.url } });
        return { ok: true, page_id: page.id, url: page.url, title };
      },
    }),

    notion_append: tool({
      description: "Acrescenta conteúdo (Markdown) ao final de uma página existente do Notion.",
      inputSchema: z.object({
        page_id: z.string().describe("ID da página."),
        content_markdown: z.string().describe("Conteúdo em Markdown a acrescentar."),
      }),
      execute: async ({ page_id, content_markdown }) => {
        try {
          await appendBlocks(page_id, markdownToBlocks(content_markdown));
          return { ok: true, page_id };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),

    notion_comment: tool({
      description: "Adiciona um comentário a uma página do Notion (status, feedback, registro de decisão).",
      inputSchema: z.object({
        page_id: z.string().describe("ID da página."),
        body: z.string().describe("Texto do comentário."),
      }),
      execute: async ({ page_id, body }) => {
        const res = await api("POST", "/comments", {
          parent: { page_id },
          rich_text: toRichText(body),
        });
        return res.ok ? { ok: true, page_id } : { ok: false, error: `Falha ao comentar (${res.status}).` };
      },
    }),

    notion_search: tool({
      description: "Busca páginas existentes no Notion por texto (evita duplicar brief/pauta).",
      inputSchema: z.object({
        query: z.string().describe("Texto a buscar nos títulos das páginas."),
      }),
      execute: async ({ query }) => {
        const res = await api("POST", "/search", {
          query,
          filter: { property: "object", value: "page" },
          page_size: 5,
        });
        if (!res.ok) return { results: [] };
        const data = (await res.json()) as {
          results?: Array<{ id: string; url?: string; properties?: Record<string, never> }>;
        };
        return {
          results: (data.results ?? []).map((p) => ({ page_id: p.id, url: p.url, title: pageTitle(p) })),
        };
      },
    }),
  };
}

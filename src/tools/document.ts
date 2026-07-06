import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { track } from "../board/board.js";
import { saveArtifact, markdownToWordHtml } from "../artifacts/store.js";

/**
 * Gera um DOCUMENTO real (arquivo Word/.doc abrível) a partir de Markdown, grava no armazém
 * e anexa como entregável do card com link de download. É o jeito de "entregar um documento
 * anexado" quando o Notion não está disponível — nada de despejar o texto na thread.
 */
export function documentTools(cardKey: string): ToolSet {
  return {
    create_document: tool({
      description:
        "Gera um DOCUMENTO Word (.doc) a partir de Markdown e o anexa como entregável do card, " +
        "com link de download. Use para ENTREGAR um documento (brief, relatório, artigo) — não " +
        "cole o conteúdo na conversa. Depois de criar, o card já tem o entregável anexado.",
      inputSchema: z.object({
        filename: z.string().describe('Nome do arquivo sem extensão (ex.: "brief-api-teste").'),
        title: z.string().describe("Título do documento (aparece no topo)."),
        content_markdown: z.string().describe("Conteúdo completo em Markdown (headings, listas, negrito)."),
      }),
      execute: async ({ filename, title, content_markdown }) => {
        const html = markdownToWordHtml(title, content_markdown);
        const saved = saveArtifact(`${filename}.doc`, html);
        track(cardKey, { deliverable: { kind: "doc", summary: title, url: saved.url } }, `documento gerado: ${saved.filename}`);
        return { ok: true, url: saved.url, filename: saved.filename };
      },
    }),
  };
}

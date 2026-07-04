import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { config } from "../config.js";
import { audit } from "../audit/log.js";

/**
 * Assets visuais: gera rascunhos de criativo (imagem) para posts/campanhas via
 * OpenAI Images API. O arquivo é salvo em ASSETS_DIR e servido pelo painel em
 * /assets/<arquivo> — a URL vai junto do post para a automação de publicação.
 * Ativa só com OPENAI_API_KEY.
 */

/** Nome de arquivo seguro a partir de um título (sem path traversal/acentos). */
export function sanitizeSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "asset"
  );
}

/** URL pública de um asset servido pelo painel. */
export function assetUrl(filename: string): string {
  const base = config.assets.publicBaseUrl || `http://localhost:${config.dashboard.port}`;
  return `${base.replace(/\/$/, "")}/assets/${filename}`;
}

export function imageTools(personaId: string): ToolSet {
  if (!process.env.OPENAI_API_KEY) return {};

  return {
    generate_image: tool({
      description:
        "Gera um rascunho de criativo (imagem) para o post/campanha. Descreva a cena, o estilo e o " +
        "texto que deve (ou não) aparecer. Retorna a URL do asset para anexar à publicação.",
      inputSchema: z.object({
        prompt: z
          .string()
          .describe("Descrição visual completa: cena, estilo (foto/ilustração/3D), paleta, enquadramento."),
        title: z.string().describe("Nome curto do asset (vira o nome do arquivo)."),
        size: z
          .enum(["1024x1024", "1536x1024", "1024x1536"])
          .optional()
          .describe("Formato: quadrado (feed), paisagem (blog/LinkedIn) ou retrato (stories)."),
      }),
      execute: async ({ prompt, title, size }) => {
        const res = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({ model: "gpt-image-1", prompt, size: size ?? "1024x1024", n: 1 }),
        });
        if (!res.ok) return { ok: false, error: `Geração de imagem falhou (${res.status}).` };
        const data = (await res.json()) as { data?: Array<{ b64_json?: string }> };
        const b64 = data.data?.[0]?.b64_json;
        if (!b64) return { ok: false, error: "Resposta sem imagem." };

        mkdirSync(config.assets.dir, { recursive: true });
        const filename = `${sanitizeSlug(title)}-${Date.now()}.png`;
        writeFileSync(join(config.assets.dir, filename), Buffer.from(b64, "base64"));
        const url = assetUrl(filename);
        audit({ kind: "asset_generated", actor: personaId, detail: title, meta: { url } });
        return { ok: true, url, filename };
      },
    }),
  };
}

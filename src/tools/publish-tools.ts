import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { MarketingDiscipline } from "../queue/types.js";
import { publishWordPress, sendEmailResend, publishWebhook, logPublication } from "../publish/publishers.js";
import { track } from "../board/board.js";

/**
 * Ferramentas de publicação por disciplina — o passo que transforma entregável em
 * resultado. TRAVADAS até a aprovação humana: o portão (request_publish_approval)
 * marca o gate como aprovado; sem isso, toda tentativa de publicar é recusada.
 */

export interface PublishGate {
  /** Setado pelo portão de aprovação quando o humano aprova. */
  approved: boolean;
  /**
   * Entregável (normalizado) que o humano aprovou. As tools de publicação só
   * aceitam corpo CONTIDO nele — aprovar "X" nunca autoriza publicar "Y".
   */
  approvedContent?: string;
}

/** Normalização usada para comparar corpo publicado × entregável aprovado. */
export function normalizeForApproval(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** null = liberado; senão o erro a retornar. */
function gateCheck(gate: PublishGate, body: string): { ok: false; error: string } | null {
  if (!gate.approved) return LOCKED;
  const n = normalizeForApproval(body);
  if (!n || !gate.approvedContent?.includes(n)) {
    return {
      ok: false as const,
      error:
        "Publicação bloqueada: o corpo difere do entregável aprovado. Peça aprovação de novo " +
        "(request_publish_approval) com o texto FINAL exatamente como será publicado.",
    };
  }
  return null;
}

interface PublishCtx {
  gate: PublishGate;
  personaId: string;
  threadKey?: string;
  cardKey?: string;
}

const LOCKED = {
  ok: false as const,
  error: "Publicação bloqueada: peça aprovação humana primeiro (request_publish_approval) e seja aprovado.",
};

function note(ctx: PublishCtx, text: string): void {
  if (ctx.cardKey) track(ctx.cardKey, {}, text);
}

/** Blog (WordPress) + e-mail (Resend) — Caio. */
function contentPublishTools(ctx: PublishCtx): ToolSet {
  return {
    publish_blog_post: tool({
      description:
        "Publica o artigo aprovado no blog (WordPress). Por padrão entra como RASCUNHO no WordPress " +
        "(WORDPRESS_STATUS=publish para ir ao ar direto). Só funciona APÓS aprovação humana.",
      inputSchema: z.object({
        title: z.string().describe("Título final do post."),
        markdown: z.string().describe("Corpo completo do artigo em Markdown."),
        excerpt: z.string().optional().describe("Resumo/meta description."),
      }),
      execute: async ({ title, markdown, excerpt }) => {
        const blocked = gateCheck(ctx.gate, markdown);
        if (blocked) return blocked;
        const res = await publishWordPress({ title, markdown, excerpt });
        if (res.ok) {
          logPublication({ channel: "blog", title, url: res.url, by: ctx.personaId, threadKey: ctx.threadKey });
          note(ctx, `publicado no blog (${res.status}): ${res.url ?? title}`);
        }
        return res;
      },
    }),

    send_email_campaign: tool({
      description:
        "Envia o e-mail/newsletter aprovado via Resend para a lista configurada (EMAIL_TO) ou " +
        "destinatários informados. Só funciona APÓS aprovação humana.",
      inputSchema: z.object({
        subject: z.string().describe("Assunto do e-mail."),
        markdown: z.string().describe("Corpo do e-mail em Markdown."),
        to: z.array(z.string()).optional().describe("Destinatários (default: lista EMAIL_TO)."),
      }),
      execute: async ({ subject, markdown, to }) => {
        const blocked = gateCheck(ctx.gate, markdown);
        if (blocked) return blocked;
        const res = await sendEmailResend({ subject, markdown, to });
        if (res.ok) {
          logPublication({ channel: "email", title: subject, by: ctx.personaId, threadKey: ctx.threadKey });
          note(ctx, `e-mail enviado: ${subject}`);
        }
        return res;
      },
    }),
  };
}

/** Social e automações via webhook genérico (Zapier/Make/n8n) — Sofia e Leo. */
function webhookPublishTools(ctx: PublishCtx, kind: "social-post" | "ads-campaign"): ToolSet {
  const isSocial = kind === "social-post";
  return {
    [isSocial ? "schedule_social_post" : "push_campaign_to_automation"]: tool({
      description: isSocial
        ? "Agenda/publica um post social aprovado via automação (webhook → Zapier/Make/n8n → rede social). " +
          "Um chamado POR post. Só funciona APÓS aprovação humana."
        : "Envia o plano de campanha aprovado para a automação (webhook → Zapier/Make/n8n → plataforma de ads). " +
          "Só funciona APÓS aprovação humana.",
      inputSchema: z.object({
        title: z.string().describe(isSocial ? "Identificação curta do post." : "Nome da campanha."),
        channel: z.string().optional().describe(isSocial ? "Canal (linkedin, instagram, x…)." : "Plataforma (meta, google…)."),
        content: z.string().describe(isSocial ? "Texto final do post." : "Plano/estrutura da campanha (JSON ou Markdown)."),
        scheduled_at: z.string().optional().describe("Quando publicar (ISO 8601). Vazio = imediato/a critério da automação."),
        image_url: z.string().optional().describe("URL do criativo (se houver)."),
      }),
      execute: async ({ title, channel, content, scheduled_at, image_url }) => {
        const blocked = gateCheck(ctx.gate, content);
        if (blocked) return blocked;
        const res = await publishWebhook({ kind, title, channel, content, scheduled_at, image_url, by: ctx.personaId });
        if (res.ok) {
          logPublication({
            channel: isSocial ? "social" : "automation",
            title,
            by: ctx.personaId,
            threadKey: ctx.threadKey,
            meta: { channel, scheduled_at },
          });
          note(ctx, `${isSocial ? "post enviado à automação" : "campanha enviada à automação"}: ${title}`);
        }
        return res;
      },
    }),
  };
}

/** Conjunto de publicação da disciplina (Nina não publica — ela mede). */
export function publishTools(discipline: MarketingDiscipline, ctx: PublishCtx): ToolSet {
  switch (discipline) {
    case "conteudo":
      return contentPublishTools(ctx);
    case "social":
      return webhookPublishTools(ctx, "social-post");
    case "ads":
      return webhookPublishTools(ctx, "ads-campaign");
    case "seo":
      return {};
  }
}

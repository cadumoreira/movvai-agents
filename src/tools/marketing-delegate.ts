import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "../agents/context.js";
import { queue } from "../queue/index.js";
import type { MarketingDiscipline } from "../queue/types.js";
import { track } from "../board/board.js";

const SPECIALIST_LABEL: Record<MarketingDiscipline, string> = {
  conteudo: "Caio (Conteúdo)",
  social: "Sofia (Social)",
  ads: "Leo (Performance)",
  seo: "Nina (SEO & Analytics)",
};

/**
 * Normaliza a disciplina pedida (aceita sinônimos comuns em PT/EN) para o
 * identificador interno. Retorna null se não reconhecer — quem chama decide o erro.
 */
export function normalizeDiscipline(input: string): MarketingDiscipline | null {
  const s = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos ("conteúdo" → "conteudo")
    .trim();
  if (/(conteudo|content|blog|copy|artigo|texto|newsletter|email)/.test(s)) return "conteudo";
  if (/(social|instagram|linkedin|tiktok|twitter|\bx\b|post|rede)/.test(s)) return "social";
  if (/(ads|anuncio|trafego|performance|campanha|midia paga|google ads|meta ads)/.test(s)) return "ads";
  if (/(seo|analytics|keyword|organico|busca|relatorio|metrica)/.test(s)) return "seo";
  return null;
}

/** Delegação PM → Head de Marketing (planejar o brief e coordenar o squad). */
export function delegateToMarketing(ctx: AgentContext): ToolSet {
  return {
    delegate_to_marketing: tool({
      description:
        "Passa uma demanda de MARKETING (conteúdo, social, campanha/ads, SEO/analytics) para a Head de " +
        "Marketing planejar. Ela cria o brief no Notion e coordena as especialistas. Não crie ticket no " +
        "Linear para demandas de marketing — o board delas é o Notion.",
      inputSchema: z.object({
        brief_title: z.string().describe("Título curto da demanda (ex.: 'Campanha de lançamento do plano Pro')."),
        instructions: z
          .string()
          .describe("O que foi pedido: objetivo, público, canais desejados, prazo e contexto relevante."),
      }),
      execute: async (t) => {
        track(
          `${ctx.threadKey}:marketing-lead`,
          { title: t.brief_title, agent: "Malu (Head de Marketing)", squad: "marketing", column: "fila" },
          "demanda delegada ao squad de marketing",
        );
        await queue.enqueue("marketing-task", {
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          threadKey: ctx.threadKey,
          brief: { title: t.brief_title },
          instructions: t.instructions,
        });
        return { ok: true, delegated_to: "marketing", brief: t.brief_title };
      },
    }),
  };
}

/** Delegação Head de Marketing → especialista por disciplina. */
export function assignMarketingWork(
  ctx: AgentContext,
  brief: { title: string; url?: string; pageId?: string },
): ToolSet {
  return {
    assign_marketing_work: tool({
      description:
        "Delega uma frente do brief à especialista da disciplina: conteudo (blog/copy — Caio), " +
        "social (posts/calendário — Sofia), ads (campanhas/tráfego pago — Leo) ou seo (SEO/analytics — Nina). " +
        "Chame uma vez POR FRENTE que o brief exigir, com instruções específicas de cada uma.",
      inputSchema: z.object({
        discipline: z
          .string()
          .describe('Disciplina: "conteudo", "social", "ads" ou "seo".'),
        instructions: z
          .string()
          .describe("Instruções específicas da frente: entregável esperado, tom, canais, restrições."),
        brief_page_id: z.string().optional().describe("ID da página do brief no Notion (se você criou uma)."),
        brief_url: z.string().optional().describe("URL do brief no Notion."),
      }),
      execute: async (t) => {
        const discipline = normalizeDiscipline(t.discipline);
        if (!discipline) {
          return { ok: false, error: `Disciplina "${t.discipline}" não reconhecida. Use: conteudo, social, ads ou seo.` };
        }
        track(
          `${ctx.threadKey}:mkt-${discipline}`,
          { title: brief.title, agent: SPECIALIST_LABEL[discipline], squad: "marketing", column: "fila" },
          "frente delegada pela Head de Marketing",
        );
        await queue.enqueue("marketing-work", {
          channel: ctx.channel,
          threadTs: ctx.threadTs,
          threadKey: ctx.threadKey,
          discipline,
          brief: {
            title: brief.title,
            url: t.brief_url ?? brief.url,
            pageId: t.brief_page_id ?? brief.pageId,
          },
          instructions: t.instructions,
        });
        return { ok: true, delegated_to: discipline };
      },
    }),
  };
}

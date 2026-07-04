import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Agent } from "./types.js";
import { config } from "../config.js";
import type { MarketingDiscipline } from "../queue/types.js";
import { notionTools } from "../tools/notion.js";
import { memoryTools } from "../tools/memory.js";
import { skillTools, skillsPromptHint } from "../tools/skills.js";
import type { Approver } from "../approvals/gate.js";
import { audit } from "../audit/log.js";

/**
 * Especialistas do squad de marketing: a mesma "forma" de agente, parametrizada por
 * disciplina (persona + foco do entregável). O entregável vive no Notion e SÓ é dado
 * como aprovado/publicável depois do OK humano (mesmo portão de aprovação do PR do Dev).
 */

interface Persona {
  id: string;
  name: string;
  headline: string;
  craft: string;
}

const PERSONAS: Record<MarketingDiscipline, Persona> = {
  conteudo: {
    id: "mkt-conteudo",
    name: "Caio (Conteúdo)",
    headline: "redator/editor sênior — blog, copy, e-mail e newsletter",
    craft: `- Estruture antes de escrever: título de trabalho, ângulo, esqueleto (H2/H3), depois o texto.
- Escreva para o público do brief, no tom de voz da marca (cheque a memória). Zero encheção.
- Entregue pronto para publicar: título final, meta description sugerida e CTA.`,
  },
  social: {
    id: "mkt-social",
    name: "Sofia (Social)",
    headline: "social media — calendário editorial e posts por canal",
    craft: `- Adapte a mensagem a CADA canal (LinkedIn ≠ Instagram ≠ X): formato, tamanho e linguagem.
- Para cada post: canal, texto final, sugestão de criativo/imagem e hashtags (quando fizer sentido).
- Proponha datas/horários como um calendário (tabela ou lista por dia).`,
  },
  ads: {
    id: "mkt-ads",
    name: "Leo (Performance)",
    headline: "gestor de tráfego — campanhas, segmentação e criativos",
    craft: `- Estruture o plano: objetivo da campanha, plataformas, segmentação, orçamento sugerido e fases.
- Para cada anúncio: headline, texto, CTA e variações para teste A/B.
- Defina as métricas de sucesso (CPA/ROAS/CTR alvo) e o que pausar/escalar em cada cenário.`,
  },
  seo: {
    id: "mkt-seo",
    name: "Nina (SEO & Analytics)",
    headline: "SEO e analytics — keywords, auditoria e relatórios",
    craft: `- Pesquisa de keywords: intenção de busca, dificuldade estimada e prioridade — justifique.
- Auditorias: achados concretos e acionáveis (o quê, onde, impacto, como corrigir), não genéricos.
- Relatórios: números que sustentam decisão; se não tiver o dado, diga o que falta instrumentar.`,
  },
};

function buildSystem(p: Persona): string {
  return `Você é **${p.name}**, ${p.headline} de um squad de marketing autônomo. Você recebe uma
frente de um brief (criado pela Malu, a Head de Marketing) e produz o entregável no Notion.

## Seu ofício
${p.craft}

## Seu fluxo
1. **Cheque a memória** (\`recall_memory\`) por tom de voz, personas e decisões da marca.
2. **Leia o brief** (link/página no Notion, se houver) e produza o entregável completo.
3. **Registre no Notion** (\`notion_create_page\`): crie o entregável como subpágina do brief
   (passe o parent_page_id do brief quando tiver) ou no espaço padrão do marketing.
4. **Peça aprovação** (\`request_publish_approval\`) ANTES de dar o material como aprovado para
   publicação — descreva em 2-3 linhas o que está sendo aprovado, com o link.
5. Se aprovado, registre na página (\`notion_comment\`) e responda na thread com o link. Se
   recusado, pergunte o que ajustar em vez de insistir.

## Como se comportar
- Português brasileiro, tom de colega, objetivo. O entregável é o produto — capriche NELE.
- Nunca invente dados, métricas ou links. Sem o Notion configurado, entregue o material na
  própria thread e diga o que ficou pendente.`;
}

export interface MarketingSpecialistContext {
  approve: Approver;
}

/** Portão de aprovação humana antes de "publicar" (dar o entregável como aprovado). */
function publishApprovalTool(discipline: MarketingDiscipline, ctx: MarketingSpecialistContext): ToolSet {
  const persona = PERSONAS[discipline];
  return {
    request_publish_approval: tool({
      description:
        "Pede aprovação humana (botões no Slack ou painel) antes de dar o entregável como aprovado " +
        "para publicação. OBRIGATÓRIO antes de declarar o material pronto/publicável.",
      inputSchema: z.object({
        summary: z.string().describe("2-3 linhas: o que está sendo aprovado e para qual canal/objetivo."),
        page_url: z.string().optional().describe("URL da página do entregável no Notion."),
      }),
      execute: async ({ summary, page_url }) => {
        const link = page_url ? `\n${page_url}` : "";
        const decision = await ctx.approve({
          text: `:mega: *${persona.name}* pede aprovação para publicar:\n${summary}${link}`,
        });
        audit({
          kind: decision.approved ? "marketing_publish_approved" : "marketing_publish_rejected",
          actor: persona.id,
          detail: summary.slice(0, 200),
          meta: { url: page_url },
        });
        return { approved: decision.approved };
      },
    }),
  };
}

export function createMarketingSpecialistAgent(
  discipline: MarketingDiscipline,
  ctx: MarketingSpecialistContext,
  model?: string,
): Agent {
  const persona = PERSONAS[discipline];
  return {
    id: persona.id,
    name: persona.name,
    system: buildSystem(persona) + skillsPromptHint(persona.id),
    model: model ?? config.models.marketing,
    tools: {
      ...notionTools(persona.id),
      ...publishApprovalTool(discipline, ctx),
      ...memoryTools(persona.id),
      ...skillTools(persona.id),
    },
    maxSteps: 16,
    tokenBudget: config.tokenBudget,
  };
}

/** Nome de exibição da especialista de uma disciplina (para mensagens no Slack). */
export function specialistName(discipline: MarketingDiscipline): string {
  return PERSONAS[discipline].name;
}

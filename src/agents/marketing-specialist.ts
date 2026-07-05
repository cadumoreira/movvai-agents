import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Agent } from "./types.js";
import { config } from "../config.js";
import type { MarketingDiscipline } from "../queue/types.js";
import { notionTools } from "../tools/notion.js";
import { memoryTools } from "../tools/memory.js";
import { skillTools, skillsPromptHint } from "../tools/skills.js";
import { askTools, type AskThread } from "../tools/ask.js";
import { publishTools, type PublishGate } from "../tools/publish-tools.js";
import { imageTools } from "../tools/image.js";
import { analyticsTools } from "../tools/analytics.js";
import { brandPromptBlock, brandTools } from "../brand/context.js";
import { learningTools, recordLesson } from "../learn/lessons.js";
import { webTools } from "../tools/web.js";
import { teamStatsTools } from "../digest/digest.js";
import { askQuestion } from "../approvals/questions.js";
import { queue } from "../queue/index.js";
import { track } from "../board/board.js";
import { createMarketingReviewerAgent, parseReviewVerdict } from "./marketing-reviewer.js";
import { runAgent } from "../agent-runtime/run.js";
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
- Relatórios: números REAIS — use \`ga4_report\` e \`search_console_query\` (se disponíveis) e cruze
  com \`list_recent_publications\` para amarrar métrica ao que o time publicou. Sem o dado, diga o
  que falta instrumentar — nunca invente número.`,
  },
};

function buildSystem(p: Persona): string {
  return `Você é **${p.name}**, ${p.headline} de um squad de marketing autônomo. Você recebe uma
frente de um brief (criado pela Malu, a Head de Marketing) e produz o entregável no Notion.

## Seu ofício
${p.craft}

## Seu fluxo
1. **Cheque a memória** (\`recall_memory\`) por tom de voz, personas e decisões da marca.
2. **Leia o brief** (link/página no Notion, se houver). Se faltar informação ESSENCIAL que você
   não pode assumir com segurança, use \`ask_clarification\` (uma pergunta objetiva) e aguarde.
3. **Produza o entregável completo** e **registre no Notion** (\`notion_create_page\`): crie como
   subpágina do brief (passe o parent_page_id quando tiver) ou no espaço padrão do marketing.
4. **Peça aprovação** (\`request_publish_approval\`) ANTES de dar o material como aprovado para
   publicação — passe o entregável COMPLETO em \`deliverable_markdown\`. A Vera (revisora) valida
   contra os playbooks antes do humano: se ela pedir ajustes, corrija e peça de novo.
5. **Aprovado? PUBLIQUE** com as ferramentas de publicação disponíveis (blog/e-mail/social);
   se nenhuma estiver configurada, o material fica pronto no Notion — diga isso na thread.
   Registre o desfecho na página (\`notion_comment\`) e responda na thread com os links.
   Se recusado pelo humano, pergunte o que ajustar em vez de insistir.
6. Precisa de criativo? Gere um rascunho com \`generate_image\` (se disponível) ANTES de pedir
   aprovação, e inclua a URL no material.
7. **Artigo aprovado rende mais:** se for um artigo de blog e \`spawn_derivatives\` estiver
   disponível, ofereça/derive thread de X, carrossel de IG e newsletter a partir dele — cada
   derivado vira uma frente própria com sua aprovação.

## Como se comportar
- Português brasileiro, tom de colega, objetivo. O entregável é o produto — capriche NELE.
- Nunca invente dados, métricas ou links. Sem o Notion configurado, entregue o material na
  própria thread e diga o que ficou pendente.
- **Aprenda com resultado real:** recusa do humano vira lição automaticamente; quando VOCÊ
  descobrir algo por conta própria (A/B medido, padrão que funcionou), use \`record_lesson\`;
  material aprovado com elogio → \`save_reference\`. Consulte licoes.md/referencias.md nas skills.`;
}

export interface MarketingSpecialistContext {
  approve: Approver;
  /** Thread do Slack (habilita ask_clarification — briefing interativo). */
  thread?: AskThread;
}

/**
 * Portão de publicação em duas camadas: a Vera (revisora) valida contra os playbooks
 * primeiro (barato, sem incomodar ninguém); só então o humano decide. MARKETING_REVIEW=off
 * pula a revisora.
 */
function publishApprovalTool(
  discipline: MarketingDiscipline,
  ctx: MarketingSpecialistContext,
  gate: PublishGate,
): ToolSet {
  const persona = PERSONAS[discipline];
  return {
    request_publish_approval: tool({
      description:
        "Pede aprovação antes de dar o entregável como publicável: a Vera (revisora) valida contra " +
        "os playbooks e, se ok, o humano decide. OBRIGATÓRIO antes de declarar o material pronto. " +
        "Se a Vera pedir ajustes, corrija o entregável e chame de novo.",
      inputSchema: z.object({
        summary: z.string().describe("2-3 linhas: o que está sendo aprovado e para qual canal/objetivo."),
        deliverable_markdown: z
          .string()
          .describe("O entregável COMPLETO (em Markdown) — é o que a revisora avalia."),
        page_url: z.string().optional().describe("URL da página do entregável no Notion."),
      }),
      execute: async ({ summary, deliverable_markdown, page_url }) => {
        let reviewNote = "";
        if (config.marketingReview) {
          const reviewer = createMarketingReviewerAgent(discipline);
          const { text } = await runAgent(reviewer, [
            {
              role: "user",
              content:
                `Revise o entregável de ${persona.name} (frente: ${discipline}).\n\n` +
                `Resumo do objetivo: ${summary}\n\n---\n\n${deliverable_markdown}`,
            },
          ]);
          const verdict = parseReviewVerdict(text ?? "");
          audit({
            kind: verdict.approved ? "marketing_review_ok" : "marketing_review_adjust",
            actor: "mkt-revisao",
            detail: summary.slice(0, 200),
          });
          if (!verdict.approved) {
            return {
              approved: false,
              reviewed_by: "Vera (Revisão)",
              feedback: verdict.feedback,
              next_step: "Ajuste o entregável conforme o feedback e chame request_publish_approval de novo.",
            };
          }
          reviewNote = "\n:white_check_mark: _Revisado pela Vera contra os playbooks._";
        }

        const link = page_url ? `\n${page_url}` : "";
        const decision = await ctx.approve({
          text: `:mega: *${persona.name}* pede aprovação para publicar:\n${summary}${link}${reviewNote}`,
        });
        audit({
          kind: decision.approved ? "marketing_publish_approved" : "marketing_publish_rejected",
          actor: persona.id,
          detail: summary.slice(0, 200),
          meta: { url: page_url },
        });
        // Destrava (ou trava) as ferramentas de publicação desta execução.
        gate.approved = decision.approved;

        // O time que APRENDE: recusa vira entrevista automática ("por quê?") e a
        // resposta vira lição permanente do papel — cada "não" melhora o time.
        if (!decision.approved && ctx.thread) {
          await ctx.thread.slack.chat.postMessage({
            channel: ctx.thread.channel,
            thread_ts: ctx.thread.threadTs,
            text:
              `:memo: Recusado — para eu aprender: *o que devo ajustar?*\n` +
              `_Responda mencionando o bot nesta thread (vira lição permanente do papel)._`,
          });
          const feedback = await askQuestion(ctx.thread.threadKey, "Motivo da recusa da publicação", persona.name);
          recordLesson(persona.id, `Recusa em "${summary.slice(0, 80)}": ${feedback}`);
          return {
            approved: false,
            feedback,
            next_step: "Ajuste o entregável conforme o feedback (já registrado como lição) e peça aprovação de novo.",
          };
        }
        return { approved: decision.approved };
      },
    }),
  };
}

/** Formatos de derivação: 1 artigo aprovado vira o pacote completo. */
const DERIVATIVE_SPECS: Record<string, { discipline: MarketingDiscipline; brief: string }> = {
  "thread-x": {
    discipline: "social",
    brief: "Transforme o artigo abaixo numa THREAD para o X (5-7 posts, 1/ 2/...): gancho forte no primeiro, uma ideia por post, CTA no último.",
  },
  "carrossel-ig": {
    discipline: "social",
    brief: "Transforme o artigo abaixo num CARROSSEL de Instagram (6-8 slides): título por slide + texto curto + descrição do visual de cada um.",
  },
  newsletter: {
    discipline: "conteudo",
    brief: "Transforme o artigo abaixo numa EDIÇÃO DE NEWSLETTER: assunto de e-mail (2 opções), abertura pessoal, resumo dos pontos e CTA.",
  },
};

/** Derivação pós-aprovação (Caio): artigo vira thread/carrossel/newsletter em jobs paralelos. */
function derivativeTools(ctx: MarketingSpecialistContext, gate: PublishGate): ToolSet {
  return {
    spawn_derivatives: tool({
      description:
        "REAPROVEITAMENTO: transforma o artigo APROVADO em derivados (thread para X, carrossel de IG, " +
        "newsletter) — cada um vira uma frente própria na mesma thread, com sua própria aprovação. " +
        "Só funciona após a aprovação humana do artigo.",
      inputSchema: z.object({
        article_title: z.string().describe("Título do artigo aprovado."),
        article_markdown: z.string().describe("O artigo aprovado COMPLETO (é o insumo dos derivados)."),
        formats: z
          .array(z.enum(["thread-x", "carrossel-ig", "newsletter"]))
          .min(1)
          .describe("Quais derivados gerar."),
      }),
      execute: async ({ article_title, article_markdown, formats }) => {
        if (!gate.approved) {
          return { ok: false, error: "Derivação bloqueada: o artigo precisa ser aprovado primeiro." };
        }
        if (!ctx.thread) return { ok: false, error: "Sem thread do Slack — derivação indisponível neste contexto." };
        const base = { channel: ctx.thread.channel, threadTs: ctx.thread.threadTs, threadKey: ctx.thread.threadKey };
        for (const format of formats) {
          const spec = DERIVATIVE_SPECS[format];
          const title = `${format}: ${article_title.slice(0, 50)}`;
          // Mesma chave que o worker usará — o card da frente acumula os derivados.
          track(
            `${ctx.thread.threadKey}:mkt-${spec.discipline}`,
            { title, agent: specialistName(spec.discipline), squad: "marketing", column: "fila" },
            `derivado do artigo aprovado (${format})`,
          );
          await queue.enqueue("marketing-work", {
            ...base,
            discipline: spec.discipline,
            brief: { title },
            instructions: `${spec.brief}\n\n--- ARTIGO APROVADO ---\n\n${article_markdown}`,
          });
        }
        return { ok: true, spawned: formats, note: "Derivados em produção na mesma thread — cada um pedirá aprovação." };
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
  // Gate de publicação: nasce travado; o portão de aprovação destrava quando o humano aprova.
  const gate: PublishGate = { approved: false };
  const cardKey = ctx.thread ? `${ctx.thread.threadKey}:${persona.id}` : undefined;
  return {
    id: persona.id,
    name: persona.name,
    system: buildSystem(persona) + brandPromptBlock() + skillsPromptHint(persona.id),
    model: model ?? config.models.marketing,
    tools: {
      ...notionTools(persona.id),
      ...publishApprovalTool(discipline, ctx, gate),
      ...publishTools(discipline, { gate, personaId: persona.id, threadKey: ctx.thread?.threadKey, cardKey }),
      ...(discipline !== "seo" ? imageTools(persona.id) : {}),
      ...(discipline === "seo" ? { ...analyticsTools(), ...teamStatsTools() } : {}),
      ...(discipline === "seo" || discipline === "conteudo" ? webTools() : {}),
      ...(discipline === "conteudo" ? derivativeTools(ctx, gate) : {}),
      ...learningTools(persona.id),
      ...memoryTools(persona.id),
      ...skillTools(persona.id),
      ...brandTools(),
      ...(ctx.thread ? askTools(ctx.thread, persona.name, cardKey) : {}),
    },
    maxSteps: 20,
    tokenBudget: config.tokenBudget,
  };
}

/** Nome de exibição da especialista de uma disciplina (para mensagens no Slack). */
export function specialistName(discipline: MarketingDiscipline): string {
  return PERSONAS[discipline].name;
}

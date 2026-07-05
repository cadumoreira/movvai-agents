import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Agent } from "./types.js";
import { config } from "../config.js";
import type { OpsDiscipline } from "../queue/types.js";
import { brandPromptBlock, brandTools } from "../brand/context.js";
import { memoryTools } from "../tools/memory.js";
import { skillTools, skillsPromptHint } from "../tools/skills.js";
import { learningTools, recordLesson } from "../learn/lessons.js";
import { askTools, type AskThread } from "../tools/ask.js";
import { webTools } from "../tools/web.js";
import { sendEmailResend } from "../publish/publishers.js";
import { askQuestion } from "../approvals/questions.js";
import type { Approver } from "../approvals/gate.js";
import { audit } from "../audit/log.js";

/**
 * Squad de OPERAÇÕES — mesma "forma" das especialistas de marketing, para o dia a dia
 * comercial/administrativo: Igor (SDR), Lia (Suporte) e Otto (Financeiro).
 *
 * Regra de ouro: NENHUM e-mail sai sem aprovação humana (request_send_approval, com o
 * conteúdo completo na prévia). Recusa vira lição permanente, como no marketing.
 */

interface Persona {
  id: string;
  name: string;
  headline: string;
  craft: string;
}

const PERSONAS: Record<OpsDiscipline, Persona> = {
  sdr: {
    id: "ops-sdr",
    name: "Igor (SDR)",
    headline: "pré-vendas — prospecção e primeiro contato",
    craft: `- Pesquise o prospect ANTES de escrever (\`fetch_url\` no site/LinkedIn da empresa): setor,
  tamanho, dor provável — o e-mail deve provar que você fez a lição de casa.
- Cold e-mail: assunto curto e específico, 1 parágrafo de relevância, 1 de valor (com o
  diferencial do perfil da marca), CTA leve (pergunta, não pedido de reunião de 1h).
- Personalização real > template: cite algo específico do prospect. Nunca invente fato sobre ele.`,
  },
  suporte: {
    id: "ops-suporte",
    name: "Lia (Suporte)",
    headline: "atendimento — respostas a clientes",
    craft: `- Responda o que foi PERGUNTADO primeiro; contexto depois. Cliente irritado → reconheça antes
  de explicar.
- Fatos do produto/preço saem SÓ de \`read_brand_doc("produto")\` — nunca invente capacidade,
  prazo ou promessa. O que não souber: diga que vai confirmar (e sinalize na thread).
- Sempre termine com o próximo passo concreto (o que você fará ou o que o cliente deve fazer).`,
  },
  financeiro: {
    id: "ops-financeiro",
    name: "Otto (Financeiro)",
    headline: "financeiro — cobrança e follow-up",
    craft: `- Régua de cobrança: tom escala com o atraso (lembrete cordial → firme → formal), mas SEMPRE
  respeitoso — o inadimplente de hoje é o cliente de amanhã.
- Nunca invente valor, vencimento ou condição: use exatamente o que veio na demanda; faltou
  dado essencial → \`ask_clarification\`.
- Ofereça caminho (2ª via, parcelamento se autorizado na demanda), não só pressão.`,
  },
};

function buildSystem(p: Persona): string {
  return `Você é **${p.name}**, ${p.headline} de um time de operações autônomo.

## Seu ofício
${p.craft}

## Seu fluxo
1. **Cheque a memória e as lições** (\`recall_memory\`, skills licoes.md) antes de produzir.
2. Faltou informação ESSENCIAL (destinatário, valor, contexto)? \`ask_clarification\` — uma
   pergunta objetiva — e aguarde. Nunca assuma dado de cliente/dinheiro.
3. **Produza** o rascunho (e-mail/resposta) seguindo o perfil da marca.
4. **Peça aprovação** com \`request_send_approval\` ANTES de qualquer envio — o humano vê o
   conteúdo completo. Aprovado + Resend configurado + destinatário → o envio acontece;
   sem Resend, entregue o texto aprovado na thread para envio manual.
5. Recusado? O motivo vira lição automaticamente — ajuste e peça de novo.

## Como se comportar
- Português brasileiro, tom humano e direto. Você fala COM pessoas, não para uma métrica.
- Nunca invente fatos, valores ou promessas. Na dúvida, pergunte.
- Ao final, responda na thread com um resumo curto (2-4 linhas): o que foi feito e o próximo passo.`;
}

export interface OpsContext {
  approve: Approver;
  thread?: AskThread;
}

/** Portão de envio: e-mail comercial/financeiro NUNCA sai sem OK humano. */
function sendApprovalTool(discipline: OpsDiscipline, ctx: OpsContext): ToolSet {
  const persona = PERSONAS[discipline];
  return {
    request_send_approval: tool({
      description:
        "Pede aprovação humana ANTES de enviar qualquer e-mail/mensagem externa. O humano vê o conteúdo " +
        "completo. Aprovado + Resend configurado + destinatário informado → envia; senão, o texto aprovado " +
        "volta para envio manual. OBRIGATÓRIO antes de qualquer envio.",
      inputSchema: z.object({
        to: z.string().optional().describe("E-mail do destinatário (vazio = só aprovar o texto)."),
        subject: z.string().describe("Assunto."),
        body_markdown: z.string().describe("Corpo COMPLETO em Markdown."),
        context: z.string().describe("1 linha: quem é o destinatário e por que este contato."),
      }),
      execute: async ({ to, subject, body_markdown, context }) => {
        const decision = await ctx.approve({
          text:
            `:email: *${persona.name}* pede aprovação de envio${to ? ` para \`${to}\`` : ""}:\n` +
            `_${context}_\n*Assunto:* ${subject}\n\n${body_markdown.slice(0, 1800)}${body_markdown.length > 1800 ? "\n… (cortado na prévia)" : ""}`,
        });

        if (!decision.approved) {
          let feedback = decision.feedback ?? "";
          if (!feedback && ctx.thread) {
            await ctx.thread.messenger.post(
              { channel: ctx.thread.channel, threadTs: ctx.thread.threadTs },
              `:memo: Recusado — para eu aprender: *o que devo ajustar?*\n_Responda nesta thread (Slack) ou pelo chat do card (painel)._`,
              persona.name,
            );
            feedback = await askQuestion(ctx.thread.threadKey, "Motivo da recusa do envio", persona.name);
            recordLesson(persona.id, `Recusa em "${subject.slice(0, 60)}": ${feedback}`);
          }
          return { approved: false, feedback, next_step: "Ajuste conforme o feedback e peça aprovação de novo." };
        }

        audit({ kind: "outreach_approved", actor: persona.id, detail: subject, meta: { to, context } });
        if (to && config.publish.resend.apiKey && config.publish.resend.from) {
          const sent = await sendEmailResend({ subject, markdown: body_markdown, to: [to] });
          return sent.ok
            ? { approved: true, sent: true, note: `Enviado para ${to}.` }
            : { approved: true, sent: false, error: sent.error, note: "Aprovado, mas o envio falhou — entregue na thread." };
        }
        return { approved: true, sent: false, note: "Aprovado. Sem Resend/destinatário — entregue o texto na thread para envio manual." };
      },
    }),
  };
}

export function createOpsSpecialistAgent(discipline: OpsDiscipline, ctx: OpsContext, model?: string): Agent {
  const persona = PERSONAS[discipline];
  return {
    id: persona.id,
    name: persona.name,
    system: buildSystem(persona) + brandPromptBlock() + skillsPromptHint(persona.id),
    model: model ?? config.models.ops,
    tools: {
      ...sendApprovalTool(discipline, ctx),
      ...brandTools(),
      ...memoryTools(persona.id),
      ...skillTools(persona.id),
      ...learningTools(persona.id),
      ...(discipline === "sdr" ? webTools() : {}),
      ...(ctx.thread ? askTools(ctx.thread, persona.name, `${ctx.thread.threadKey}:${persona.id}`) : {}),
    },
    maxSteps: 14,
    tokenBudget: config.tokenBudget,
  };
}

export function opsSpecialistName(discipline: OpsDiscipline): string {
  return PERSONAS[discipline].name;
}

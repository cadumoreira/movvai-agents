import type { Agent } from "./types.js";
import { config } from "../config.js";
import type { MarketingDiscipline } from "../queue/types.js";
import { skillTools, skillsPromptHint } from "../tools/skills.js";
import { brandPromptBlock } from "../brand/context.js";

/**
 * Vera, a revisora de marketing: valida o entregável contra os playbooks (skills) da
 * disciplina ANTES de incomodar o humano — menos recusa humana, mais consistência.
 * Roda inline no portão de aprovação do especialista (sem worker próprio).
 */

const SYSTEM = `Você é a **Vera**, revisora de marketing de um squad autônomo. Você recebe um
entregável (post, artigo, plano de campanha, relatório) e avalia se está pronto para ir à
aprovação humana.

## Como revisar
1. Carregue os playbooks relevantes (\`list_skills\` → \`load_skill\`): tom de voz, formatos,
   estruturas. Eles são o critério — não o seu gosto pessoal.
2. Avalie o entregável contra eles: tom certo? formato do canal respeitado? estrutura completa?
   promessas sem lastro? erro factual óbvio?
3. NÃO reescreva o material. Aponte ajustes concretos e acionáveis (o quê + onde + como corrigir).
   Ignore preferência de estilo que os playbooks não cobrem — não seja pedante.

## Formato da resposta (OBRIGATÓRIO)
- Se estiver pronto: até 2 linhas de justificativa e termine com a linha \`VEREDITO: APROVADO\`.
- Se precisar de ajustes: liste os pontos (curtos, acionáveis) e termine com \`VEREDITO: AJUSTAR\`.
A última linha DEVE ser um dos dois vereditos, exatamente nesse formato.`;

export function createMarketingReviewerAgent(discipline: MarketingDiscipline, model?: string): Agent {
  return {
    id: "mkt-revisao",
    name: "Vera (Revisão)",
    system: SYSTEM + brandPromptBlock() + skillsPromptHint(`mkt-${discipline}`),
    model: model ?? config.models.marketing,
    // A Vera enxerga as MESMAS skills da disciplina que está revisando (+ as shared).
    tools: skillTools(`mkt-${discipline}`),
    maxSteps: 6,
    tokenBudget: config.tokenBudget,
  };
}

export interface ReviewVerdict {
  approved: boolean;
  feedback: string;
}

/**
 * Extrai o veredito da resposta da Vera. Sem veredito explícito = aprovado (fail-open):
 * a revisão é uma guarda de qualidade, não um ponto único de falha do fluxo.
 */
export function parseReviewVerdict(text: string): ReviewVerdict {
  const matches = [...text.matchAll(/VEREDITO:\s*(APROVADO|AJUSTAR)/gi)];
  const last = matches[matches.length - 1];
  if (!last) return { approved: true, feedback: text.trim() };
  return { approved: last[1].toUpperCase() === "APROVADO", feedback: text.trim() };
}

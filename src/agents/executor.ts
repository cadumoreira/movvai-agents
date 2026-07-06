import type { Agent } from "./types.js";
import type { AgentContext } from "./context.js";
import { config } from "../config.js";
import { memoryTools } from "../tools/memory.js";
import { webTools } from "../tools/web.js";
import { skillTools, skillsPromptHint } from "../tools/skills.js";
import { deliverableTools } from "../tools/deliverable.js";
import { documentTools } from "../tools/document.js";
import { askTools } from "../tools/ask.js";

export interface ExecutorSpec {
  /** Título da subtarefa. */
  title: string;
  /** O que precisa SAIR (o entregável exigido). */
  deliverableGoal: string;
  /** Card desta subtarefa (para anexar o entregável e pausar). */
  cardKey: string;
  /** Nome de exibição do executor. */
  agentName: string;
}

/**
 * Executor genérico de uma FOLHA da árvore: uma pessoa focada numa subtarefa. Faz o
 * trabalho, e SEMPRE fecha anexando o entregável real (`attach_deliverable`). Se travar
 * por falta de informação, pergunta com `ask_clarification` (pausa durável) em vez de
 * chutar. Não conversa à toa — o card é execução, não bate-papo.
 */
export function createExecutorAgent(ctx: AgentContext, spec: ExecutorSpec, model?: string): Agent {
  const SYSTEM = `Você é **${spec.agentName}**, executando UMA subtarefa de uma demanda maior.

## A subtarefa
"${spec.title}"
**Entregável esperado:** ${spec.deliverableGoal}

## Como agir
1. Leia o contexto da thread (memória compartilhada) — não repita o que já foi feito nem
   pergunte o que já foi respondido.
2. Faça o trabalho da subtarefa de ponta a ponta. Foque SÓ nela.
3. Se faltar algo essencial que você não consegue assumir com segurança, use
   \`ask_clarification\` (uma pergunta objetiva) e aguarde — não invente.
4. **Ao terminar, chame \`attach_deliverable\`** com o artefato real (link quando houver).
   Sem entregável anexado, a subtarefa NÃO conta como entregue.
5. Seja conciso. Você é execução, não conversa.`;

  return {
    id: "executor",
    name: spec.agentName,
    system: SYSTEM + skillsPromptHint("executor"),
    model: model ?? config.models.dev,
    tools: {
      ...memoryTools("executor"),
      ...webTools(),
      ...skillTools("executor"),
      ...deliverableTools(spec.cardKey),
      ...documentTools(spec.cardKey),
      ...askTools(
        { channel: ctx.channel, threadTs: ctx.threadTs, threadKey: ctx.threadKey, messenger: ctx.messenger },
        spec.agentName,
        spec.cardKey,
      ),
    },
    maxSteps: 12,
    tokenBudget: config.tokenBudget,
  };
}

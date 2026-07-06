import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "../agents/context.js";
import { decomposePlan } from "../orchestration/decompose.js";
import type { BoardCard } from "../board/board.js";

/**
 * Ferramenta de PLANEJAMENTO: quebra a tarefa numa árvore de subtarefas executáveis, cada
 * uma vira um card filho com seu entregável e um executor. Este card (o do planejador) é o
 * pai — fecha por rollup quando todas as folhas entregarem. Use quando a demanda tem mais de
 * um entregável distinto (ex.: "criar contrato", "implementar", "testes", "deploy").
 */
export function decomposeTools(ctx: AgentContext, parentKey: string, squad: BoardCard["squad"] = "produto"): ToolSet {
  return {
    decompose: tool({
      description:
        "Quebra a tarefa numa árvore de subtarefas executáveis (uma por entregável distinto). " +
        "Cada subtarefa vira um card filho com seu entregável e vai para um executor. Detalhe bem: " +
        "título claro, o entregável concreto que precisa sair, e instruções específicas. Chame UMA vez.",
      inputSchema: z.object({
        subtasks: z
          .array(
            z.object({
              title: z.string().describe("Título curto e claro (ex.: 'Criar contrato da API')."),
              deliverable: z.string().describe("O artefato concreto que precisa sair (ex.: 'spec OpenAPI aprovada')."),
              instructions: z.string().describe("Instruções específicas para o executor da folha."),
              agent_name: z.string().optional().describe("Nome do executor (default 'Téo (Dev)')."),
            }),
          )
          .min(1)
          .describe("As subtarefas, na ordem de execução. Só o necessário — nem raso demais, nem infinito."),
      }),
      execute: async ({ subtasks }) => {
        const keys = await decomposePlan(
          parentKey,
          { channel: ctx.channel, threadTs: ctx.threadTs, threadKey: ctx.threadKey, squad },
          subtasks.map((s) => ({
            title: s.title,
            deliverable: s.deliverable,
            instructions: s.instructions,
            agentName: s.agent_name,
          })),
        );
        return { ok: true, created: keys.length, cards: keys };
      },
    }),
  };
}

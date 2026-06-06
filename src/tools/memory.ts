import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { memory } from "../memory/long-term.js";

/**
 * Ferramentas de memória de longo prazo. Permitem aos agentes guardar decisões/contexto
 * do projeto e recuperá-los em sessões futuras. No-op se DATABASE_URL não estiver setado.
 */
export function memoryTools(agentId: string): ToolSet {
  return {
    recall_memory: tool({
      description:
        "Busca na memória de longo prazo do time por contexto relevante (decisões passadas, convenções do projeto). Use no começo de uma tarefa.",
      inputSchema: z.object({ query: z.string().describe("O que você quer lembrar.") }),
      execute: async ({ query }) => {
        const results = await memory.recall(query);
        return { results: results.map((r) => r.content) };
      },
    }),

    remember_fact: tool({
      description:
        "Salva na memória de longo prazo uma decisão ou fato importante do projeto, para o time reusar depois.",
      inputSchema: z.object({ content: z.string().describe("O fato/decisão a guardar.") }),
      execute: async ({ content }) => {
        await memory.remember(agentId, content);
        return { ok: true };
      },
    }),
  };
}

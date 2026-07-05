import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Messenger } from "../messaging/messenger.js";
import { askQuestion } from "../approvals/questions.js";
import { track } from "../board/board.js";

export interface AskThread {
  channel: string;
  threadTs: string;
  threadKey: string;
  messenger: Messenger;
}

/**
 * Briefing interativo: quando falta informação ESSENCIAL, o agente pergunta na thread
 * e pausa até a resposta (interrupção durável, como a aprovação). O humano responde
 * mencionando o bot na thread (Slack) ou pelo chat do card (painel).
 */
export function askTools(thread: AskThread, askerLabel: string, cardKey?: string): ToolSet {
  return {
    ask_clarification: tool({
      description:
        "Faz UMA pergunta objetiva ao humano na thread e ESPERA a resposta antes de continuar. " +
        "Use só quando faltar informação essencial que você não consegue assumir com segurança " +
        "(público? prazo? orçamento?). Não interrogue: junte o que falta numa pergunta só.",
      inputSchema: z.object({
        question: z.string().describe("A pergunta, curta e específica. Uma por vez."),
      }),
      execute: async ({ question }) => {
        await thread.messenger.post(
          { channel: thread.channel, threadTs: thread.threadTs },
          `:question: *${askerLabel}* pergunta:\n${question}\n_Responda nesta thread (Slack) ou pelo chat do card (painel)._`,
          askerLabel,
        );
        if (cardKey) track(cardKey, { column: "aprovacao" }, `perguntou: ${question.slice(0, 80)}`);
        const answer = await askQuestion(thread.threadKey, question, askerLabel);
        if (cardKey) track(cardKey, { column: "execucao" }, "resposta recebida — continuando");
        return { answer };
      },
    }),
  };
}

import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2Content } from "@ai-sdk/provider";

/**
 * Modelo MOCK roteirizado ("mock:*") — para rodar o FLUXO inteiro de ponta a ponta
 * sem gastar tokens nem exigir chave: fila, handoffs, portão de aprovação, Vera,
 * board e preflight são todos REAIS; só o "pensar" do modelo é um roteiro fixo.
 *
 *   MARKETING_MODEL=mock:marketing CHEAP_MODEL=mock:marketing npm run try:marketing
 *
 * O roteiro decide pelo NOME da persona no system prompt + quantas respostas de
 * ferramenta já existem na conversa (em qual passo do loop estamos).
 */

/** Post roteirizado — o entregável de exemplo do dry-run (empresa nova, Instagram). */
const IG_POST = `## Post de lançamento — Instagram

**Legenda:**
Chegou a Movvai. 🚀
Times autônomos de IA que trabalham nas SUAS ferramentas — Slack, Notion, GitHub —
com a sua aprovação em cada ponto-chave.
Menos operação, mais direção. Link na bio.

**Criativo (descrição):** fundo claro, logo centralizado, headline "Seu dream team,
no ar" em Inter 800; paleta roxo #7B68EE sobre #FAFBFC.

**Hashtags:** #agentesdeia #produtividade #startupbrasil
**Melhor horário:** terça, 19h (pico de alcance orgânico B2B no IG).`;

function systemOf(options: LanguageModelV2CallOptions): string {
  const first = options.prompt[0];
  if (first?.role === "system") return first.content;
  return "";
}

function toolResultCount(options: LanguageModelV2CallOptions): number {
  return options.prompt.filter((m) => m.role === "tool").length;
}

const text = (t: string): LanguageModelV2Content[] => [{ type: "text", text: t }];
const toolCall = (name: string, input: Record<string, unknown>): LanguageModelV2Content[] => [
  { type: "tool-call", toolCallId: `mock-${name}-${Math.random().toString(36).slice(2, 8)}`, toolName: name, input: JSON.stringify(input) },
];

/** O roteiro: persona + passo → conteúdo. */
function script(options: LanguageModelV2CallOptions): LanguageModelV2Content[] {
  const system = systemOf(options);
  const step = toolResultCount(options);

  // Vera (revisora): parecer único, aprovando — exercita o caminho da revisão.
  if (system.includes("Você é a **Vera**")) {
    return text("Tom e formato consistentes com o playbook e o perfil da marca.\nVEREDITO: APROVADO");
  }

  // Malu (Head): delega a frente social e encerra.
  if (system.includes("Você é a **Malu**")) {
    if (step === 0) {
      return toolCall("assign_marketing_work", {
        discipline: "social",
        instructions:
          "Criar 1 post de lançamento para o Instagram da empresa (empresa nova, primeiro post). " +
          "Objetivo: apresentar a marca e gerar visita ao site. Use o tom de voz e a identidade do perfil da marca.",
      });
    }
    return text("Brief planejado e frente social delegada à Sofia. (Sem Notion neste ambiente — brief registrado na thread.)");
  }

  // Sofia (Social): produz o post e pede aprovação; publica/encerra conforme a decisão.
  if (system.includes("Você é **Sofia")) {
    if (step === 0) {
      return toolCall("request_publish_approval", {
        summary: "Post único de lançamento no Instagram da marca (primeiro post da empresa) — objetivo: apresentação + visita ao site.",
        deliverable_markdown: IG_POST,
      });
    }
    const lastTool = JSON.stringify(options.prompt[options.prompt.length - 1] ?? "");
    if (lastTool.includes('\\"approved\\":true') || lastTool.includes('"approved":true')) {
      return text(`Aprovado! Post pronto para publicar:\n\n${IG_POST}\n\n(Automação de publicação não configurada — publicação manual.)`);
    }
    return text("Publicação recusada — aguardo orientação do que ajustar.");
  }

  // Persona fora do roteiro: encerra com aviso claro (não silencie erros de fiação).
  return text("[mock] Persona sem roteiro — nada a fazer.");
}

export function createMockModel(modelId: string): LanguageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const content = script(options);
      const hasToolCall = content.some((c) => c.type === "tool-call");
      return {
        content,
        finishReason: hasToolCall ? "tool-calls" : "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("mock: use doGenerate (sem streaming).");
    },
  };
}

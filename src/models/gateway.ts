import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { config } from "../config.js";

/**
 * Gateway de modelos agnóstico de provedor.
 *
 * Recebe uma referência no formato "provedor:modelo" (ex.: "anthropic:claude-opus-4-8",
 * "openai:gpt-5", "google:gemini-3-pro") e devolve um LanguageModel da Vercel AI SDK,
 * que unifica tool-calling/streaming entre provedores.
 *
 * Se MODEL_GATEWAY_BASE_URL estiver definido (ex.: LiteLLM self-hosted), TODOS os modelos
 * passam por lá via interface OpenAI-compatible — centralizando roteamento, caching e custo.
 * Esse é o "denominador comum"; o passthrough nativo por provedor entra em fases seguintes
 * para recursos que vazam (caching, tool-calling paralelo, structured output).
 */
export function resolveModel(ref: string): LanguageModel {
  const [provider, ...rest] = ref.split(":");
  const modelId = rest.join(":");
  if (!modelId) {
    throw new Error(
      `Referência de modelo inválida: "${ref}". Use o formato "provedor:modelo".`,
    );
  }

  // Gateway único na frente de tudo (LiteLLM/OpenAI-compatible).
  if (config.models.gatewayBaseUrl) {
    const gateway = createOpenAICompatible({
      name: "gateway",
      baseURL: config.models.gatewayBaseUrl,
      apiKey: config.models.gatewayApiKey || undefined,
    });
    // No gateway, o "provedor" vira só parte do nome do modelo (ex.: o LiteLLM resolve).
    return gateway(provider === "gateway" ? modelId : `${provider}/${modelId}`);
  }

  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: env("ANTHROPIC_API_KEY") })(modelId);
    case "openai":
      return createOpenAI({ apiKey: env("OPENAI_API_KEY") })(modelId);
    case "google":
      return createGoogleGenerativeAI({
        apiKey: env("GOOGLE_GENERATIVE_AI_API_KEY"),
      })(modelId);
    default:
      throw new Error(
        `Provedor desconhecido: "${provider}". Suportados: anthropic, openai, google, gateway.`,
      );
  }
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Provedor selecionado exige ${name}, mas a variável não está definida.`,
    );
  }
  return v;
}

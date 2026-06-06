import { generateText } from "ai";
import { config } from "../config.js";
import { resolveModel } from "../models/gateway.js";
import { telemetryEnabled } from "../observability/otel.js";

export interface CouncilResult {
  recommendation: string;
  proposals: Array<{ model: string; answer: string }>;
}

const PROPOSER_SYSTEM = `Você é um especialista dando um parecer técnico independente. Seja direto e
fundamentado: dê sua recomendação e o porquê em poucas linhas. Você pode discordar do senso comum se
tiver razão para isso.`;

const SYNTH_SYSTEM = `Você é o árbitro de um conselho técnico. Recebe pareceres independentes de vários
modelos sobre a mesma questão. Sua tarefa: pesar os pareceres (onde concordam, onde divergem e por quê)
e produzir UMA recomendação final clara e acionável, sinalizando o nível de confiança. Não invente
consenso que não existe — se houver divergência relevante, diga.`;

/**
 * Conselho multi-modelo (Mixture-of-Agents): vários modelos dão parecer em paralelo e um
 * sintetiza a recomendação final. É o "modelos conversando entre si" — usado seletivamente
 * em decisões de alto valor (veredito de QA, escolha de arquitetura), pois multi-modelo
 * custa mais tokens e nem sempre melhora (ver pesquisa). Desligado se < 2 modelos.
 */
export async function deliberate(question: string, context: string): Promise<CouncilResult> {
  const models = config.council.models;

  // 1. Pareceres independentes, em paralelo.
  const proposals = await Promise.all(
    models.map(async (m) => {
      const r = await generateText({
        model: resolveModel(m),
        system: PROPOSER_SYSTEM,
        prompt: `Contexto:\n${context}\n\nQuestão: ${question}`,
        experimental_telemetry: { isEnabled: telemetryEnabled(), functionId: "council:proposer" },
      });
      return { model: m, answer: r.text };
    }),
  );

  // 2. Síntese final.
  const synthModel = config.council.synthModel || models[0];
  const dossier = proposals.map((p, i) => `### Parecer ${i + 1} (${p.model})\n${p.answer}`).join("\n\n");
  const synth = await generateText({
    model: resolveModel(synthModel),
    system: SYNTH_SYSTEM,
    prompt: `Questão: ${question}\n\nPareceres do conselho:\n${dossier}\n\nProduza a recomendação final.`,
    experimental_telemetry: { isEnabled: telemetryEnabled(), functionId: "council:synth" },
  });

  console.log(
    JSON.stringify({
      level: "info",
      kind: "council",
      models,
      synthModel,
      at: new Date().toISOString(),
    }),
  );

  return { recommendation: synth.text, proposals };
}

/** Conselho disponível só com ≥2 modelos configurados (caso contrário não há "debate"). */
export function councilEnabled(): boolean {
  return config.council.models.length >= 2;
}

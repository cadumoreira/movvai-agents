import { config } from "../config.js";

/**
 * Roteador de custo (heurístico). Para tarefas simples, rebaixa para um modelo barato;
 * para tarefas complexas, mantém o modelo "forte" do papel. Loga a decisão para você
 * medir se a economia está acontecendo (a pesquisa alertou para "routing collapse").
 *
 * MVP: heurística por tamanho/sinais do texto. Evolução: router aprendido (RouteLLM)
 * treinado no seu próprio tráfego.
 */
const COMPLEX_SIGNALS = [
  "refactor",
  "refatora",
  "arquitetura",
  "migra",
  "concorr",
  "performance",
  "segurança",
  "security",
  "race condition",
  "deadlock",
  "multiple files",
  "vários arquivos",
];

export function routeModel(roleModel: string, signal: { text: string }): string {
  const text = signal.text.toLowerCase();
  const looksComplex =
    text.length > 280 || COMPLEX_SIGNALS.some((k) => text.includes(k));

  const chosen = looksComplex || !config.models.cheap ? roleModel : config.models.cheap;

  console.log(
    JSON.stringify({
      level: "info",
      kind: "model_routing",
      complexity: looksComplex ? "high" : "low",
      chosen,
      roleModel,
      at: new Date().toISOString(),
    }),
  );

  return chosen;
}

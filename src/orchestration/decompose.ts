import { track, type BoardCard } from "../board/board.js";
import { queue } from "../queue/index.js";

export interface SubtaskSpec {
  /** Título curto da subtarefa (ex.: "Criar contrato da API"). */
  title: string;
  /** O que precisa SAIR (ex.: "spec OpenAPI aprovada"). Vira o entregável exigido. */
  deliverable: string;
  /** Instruções específicas para o executor. */
  instructions: string;
  /** Nome de exibição do executor (default "Téo (Dev)"). */
  agentName?: string;
}

export interface DecomposeThread {
  channel: string;
  threadTs: string;
  threadKey: string;
  squad?: BoardCard["squad"];
}

/**
 * Quebra um card-pai numa árvore de subtarefas. Cria UM card filho por subtarefa (na
 * fila, com `parentKey` e o entregável esperado na nota) e enfileira um job "subtask"
 * para cada. O pai só fecha por rollup quando todas as folhas entregarem.
 *
 * Invariante do rollup: cria TODOS os cards ANTES de enfileirar qualquer executor —
 * assim "todos os filhos concluídos" nunca dá falso-positivo por decomposição parcial.
 *
 * Retorna as chaves dos cards criados.
 */
export async function decomposePlan(
  parentKey: string,
  thread: DecomposeThread,
  subtasks: SubtaskSpec[],
): Promise<string[]> {
  const squad = thread.squad ?? "produto";
  const keys = subtasks.map((_, i) => `${parentKey}#${i + 1}`);

  // 1) Marca o pai como decomposto e cria TODOS os filhos antes de executar.
  track(parentKey, { column: "execucao" }, `decomposto em ${subtasks.length} subtarefas`);
  subtasks.forEach((s, i) => {
    track(
      keys[i],
      {
        title: s.title,
        agent: s.agentName ?? "Téo (Dev)",
        squad,
        column: "fila",
        parentKey,
      },
      `subtarefa criada — entregável esperado: ${s.deliverable}`,
    );
  });

  // 2) Enfileira os executores das folhas.
  await Promise.all(
    subtasks.map((s, i) =>
      queue.enqueue("subtask", {
        channel: thread.channel,
        threadTs: thread.threadTs,
        threadKey: thread.threadKey,
        parentKey,
        cardKey: keys[i],
        title: s.title,
        deliverableGoal: s.deliverable,
        instructions: s.instructions,
        agentName: s.agentName,
        squad,
      }),
    ),
  );

  return keys;
}

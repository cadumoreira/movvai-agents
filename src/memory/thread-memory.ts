import type { ModelMessage } from "ai";

/**
 * Memória de conversa por thread do Slack.
 *
 * MVP: em memória (Map). A interface permite trocar por Postgres/pgvector depois
 * (memória de longo prazo) sem mexer no runtime dos agentes.
 */
export interface ThreadMemory {
  get(threadKey: string): ModelMessage[];
  append(threadKey: string, ...messages: ModelMessage[]): void;
}

export class InMemoryThreadMemory implements ThreadMemory {
  private store = new Map<string, ModelMessage[]>();
  /** Mantém só os últimos N turnos para conter custo (loop O(N²)). */
  constructor(private readonly maxMessages = 20) {}

  get(threadKey: string): ModelMessage[] {
    return this.store.get(threadKey) ?? [];
  }

  append(threadKey: string, ...messages: ModelMessage[]): void {
    const current = this.store.get(threadKey) ?? [];
    const next = [...current, ...messages];
    this.store.set(threadKey, next.slice(-this.maxMessages));
  }
}

/**
 * Board (kanban) da atuação dos agentes: um card por frente de trabalho, andando por
 * colunas fixas — Fila → Em atuação → Aguardando aprovação → Concluído. Alimentado
 * pelos pontos de instrumentação (menção, delegação, workers, portão de aprovação)
 * e exibido ao vivo no painel (/api/board).
 *
 * MVP: em memória (mesmo padrão da atividade/aprovações). Persistir é passo futuro.
 */

export const BOARD_COLUMNS = ["fila", "execucao", "aprovacao", "concluido"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const COLUMN_LABELS: Record<BoardColumn, string> = {
  fila: "Fila",
  execucao: "Em atuação",
  aprovacao: "Aguardando humano", // aprovação OU resposta a pergunta de esclarecimento
  concluido: "Concluído",
};

export type BoardOutcome = "ok" | "falha" | "recusado";

export interface BoardCard {
  /** Chave estável da frente (ex.: "C01:171234.5:dev"). Reutilizada nas transições. */
  key: string;
  title: string;
  /** Nome de exibição do agente responsável (ex.: "Téo (Dev)"). */
  agent: string;
  squad: "produto" | "marketing" | "operacoes";
  column: BoardColumn;
  /** Como terminou (só faz sentido em "concluido"). */
  outcome?: BoardOutcome;
  /** Última nota de progresso (o histórico completo fica em `notes`). */
  notes: Array<{ time: string; text: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface TrackPatch {
  title?: string;
  agent?: string;
  squad?: "produto" | "marketing" | "operacoes";
  column?: BoardColumn;
  outcome?: BoardOutcome;
}

/** Máximo de cards retidos; ao estourar, descarta os concluídos mais antigos primeiro. */
const MAX_CARDS = 200;
const MAX_NOTES = 20;

const cards = new Map<string, BoardCard>();

/** Restaura o board da persistência (Redis) no boot. No-op sem REDIS_URL. */
export async function initBoard(): Promise<void> {
  const { boardStore } = await store();
  for (const card of await boardStore.loadAll()) {
    if (!cards.has(card.key)) cards.set(card.key, card);
  }
}

/** Import do store cacheado (dinâmico para evitar ciclo board↔store). */
let storeModule: Promise<typeof import("./store.js")> | null = null;
function store(): Promise<typeof import("./store.js")> {
  return (storeModule ??= import("./store.js"));
}

/** Persiste um card (best-effort — a persistência não trava o fluxo). */
function persist(card: BoardCard): void {
  void store().then(({ boardStore }) => boardStore.save(card));
}

/**
 * Cria/atualiza o card de uma frente de trabalho. Idempotente: chamar de novo com a
 * mesma chave só aplica o patch (e registra a nota) — quem chega primeiro cria.
 */
export function track(key: string, patch: TrackPatch, note?: string): BoardCard {
  const now = new Date().toISOString();
  let card = cards.get(key);
  if (!card) {
    card = {
      key,
      title: patch.title ?? "(sem título)",
      agent: patch.agent ?? "?",
      squad: patch.squad ?? "produto",
      column: patch.column ?? "fila",
      notes: [],
      createdAt: now,
      updatedAt: now,
    };
    cards.set(key, card);
    if (patch.outcome) card.outcome = patch.outcome;
  } else {
    if (patch.title) card.title = patch.title;
    if (patch.agent) card.agent = patch.agent;
    if (patch.squad) card.squad = patch.squad;
    if (patch.column) card.column = patch.column;
    if (patch.outcome) card.outcome = patch.outcome;
    card.updatedAt = now;
  }
  if (note) {
    card.notes.push({ time: now, text: note });
    if (card.notes.length > MAX_NOTES) card.notes.shift();
  }
  persist(card);
  evict();
  return card;
}

/**
 * Vigia de frentes órfãs: card parado em "fila"/"execucao" além do limite (worker
 * morto, processo reiniciado) vira "concluido/falha" com nota explícita — nada fica
 * girando para sempre no board. Retorna os cards varridos (para log/teste).
 */
export function sweepStaleCards(maxAgeMs: number, now = Date.now()): BoardCard[] {
  const stale = [...cards.values()].filter(
    (c) => (c.column === "execucao" || c.column === "fila") && now - Date.parse(c.updatedAt) > maxAgeMs,
  );
  for (const c of stale) {
    track(c.key, { column: "concluido", outcome: "falha" }, "sem progresso — marcada como falha pelo vigia (worker possivelmente reiniciado)");
  }
  return stale;
}

/** Todos os cards, mais recentes primeiro (o front agrupa por coluna). */
export function listBoard(): BoardCard[] {
  return [...cards.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Limpa o board (usado em testes). */
export function resetBoard(): void {
  cards.clear();
}

function evict(): void {
  if (cards.size <= MAX_CARDS) return;
  const drop = (key: string) => {
    cards.delete(key);
    void store().then(({ boardStore }) => boardStore.remove(key));
  };
  const done = [...cards.values()]
    .filter((c) => c.column === "concluido")
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
  for (const c of done) {
    if (cards.size <= MAX_CARDS) return;
    drop(c.key);
  }
  // Ainda acima do teto (tudo ativo)? Descarta os mais antigos.
  const oldest = [...cards.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
  for (const c of oldest) {
    if (cards.size <= MAX_CARDS) return;
    drop(c.key);
  }
}

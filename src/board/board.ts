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

/**
 * O artefato produzido por um card. Todo card só pode fechar `ok` apontando para algo
 * concreto — sem isso o board "mente" (ver o caso do brand book fantasma). Quando não há
 * integração (Notion/GitHub off), `kind: "thread"` registra que a entrega saiu na conversa.
 */
export interface Deliverable {
  /** Tipo do artefato: "pr", "notion", "url", "doc", "thread", "arvore" (decomposição)… */
  kind: string;
  /** Resumo de uma linha do que foi entregue. */
  summary: string;
  /** Link para o artefato, quando existir. */
  url?: string;
}

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
  /** Card pai na árvore (Demanda → Tarefa → Subtarefa). Ausente = raiz. */
  parentKey?: string;
  /** Artefato produzido. Exigido para fechar `ok` (exceto cards-pai, que agregam). */
  deliverable?: Deliverable;
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
  parentKey?: string;
  deliverable?: Deliverable;
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
  // Aprovações são promises em memória: um card restaurado em "aprovacao" não tem
  // mais quem o destrave (o registry nasce vazio). Marca como falha com nota clara
  // em vez de exibir "Aguardando humano" para sempre; se a fila durável reentregar
  // o job, a frente re-tracka e volta ao fluxo normal.
  for (const card of cards.values()) {
    if (card.column === "aprovacao") {
      track(card.key, { column: "concluido", outcome: "falha" }, "aprovação perdida no restart — reabra a demanda na thread");
    }
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
  const wasConcluido = card?.column === "concluido";
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
    if (patch.parentKey) card.parentKey = patch.parentKey;
    if (patch.deliverable) card.deliverable = patch.deliverable;
  } else {
    if (patch.title) card.title = patch.title;
    if (patch.agent) card.agent = patch.agent;
    if (patch.squad) card.squad = patch.squad;
    if (patch.column) card.column = patch.column;
    if (patch.outcome) card.outcome = patch.outcome;
    if (patch.parentKey) card.parentKey = patch.parentKey;
    if (patch.deliverable) card.deliverable = patch.deliverable;
    card.updatedAt = now;
  }
  if (note) {
    card.notes.push({ time: now, text: note });
    if (card.notes.length > MAX_NOTES) card.notes.shift();
  }
  persist(card);
  evict();
  // Rollup: um filho que ACABOU de concluir pode fechar o pai (se todos os irmãos
  // concluíram). Só dispara na transição para "concluido", não em toques repetidos.
  if (card.parentKey && card.column === "concluido" && !wasConcluido) {
    rollupParent(card.parentKey);
  }
  return card;
}

/** Filhos diretos de um card. */
export function childrenOf(parentKey: string): BoardCard[] {
  return [...cards.values()].filter((c) => c.parentKey === parentKey);
}

/**
 * Avalia um card-pai à luz dos filhos: quando TODOS concluíram, fecha o pai — `ok` se
 * todos ok, senão `falha` (um filho que falha segura/derruba o pai). Enquanto houver
 * filho em aberto, atualiza a nota de progresso (X/Y) e mantém o pai em atuação.
 *
 * Invariante: o orquestrador cria TODOS os filhos antes de qualquer um executar, então
 * "todos concluídos" nunca é falso-positivo por decomposição parcial.
 */
export function rollupParent(parentKey: string): void {
  const parent = cards.get(parentKey);
  const kids = childrenOf(parentKey);
  if (!parent || kids.length === 0) return;
  if (parent.column === "concluido") return; // já fechado — nada a fazer

  const done = kids.filter((k) => k.column === "concluido");
  if (done.length < kids.length) {
    track(parentKey, { column: "execucao" }, `${done.length}/${kids.length} subtarefas concluídas`);
    return;
  }
  const failed = done.filter((k) => k.outcome && k.outcome !== "ok");
  const outcome: BoardOutcome = failed.length ? "falha" : "ok";
  const note = failed.length
    ? `${failed.length}/${kids.length} subtarefas falharam — pai bloqueado`
    : `todas as ${kids.length} subtarefas entregues`;
  track(parentKey, {
    column: "concluido",
    outcome,
    deliverable: { kind: "arvore", summary: note },
  }, note);
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

export interface BoardTreeNode extends BoardCard {
  children: BoardTreeNode[];
}

/**
 * Board como árvore (Demanda → Tarefa → Subtarefa), raízes primeiro. Um filho cujo pai
 * já foi descartado (evict) vira raiz — nada some da visão.
 */
export function boardTree(): BoardTreeNode[] {
  const nodes = new Map<string, BoardTreeNode>();
  for (const c of cards.values()) nodes.set(c.key, { ...c, children: [] });
  const roots: BoardTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentKey ? nodes.get(node.parentKey) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const byUpdated = (a: BoardCard, b: BoardCard) => (a.updatedAt < b.updatedAt ? 1 : -1);
  for (const node of nodes.values()) node.children.sort(byUpdated);
  return roots.sort(byUpdated);
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

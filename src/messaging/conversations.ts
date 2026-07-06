/**
 * Registro em memória das conversas por thread — a "thread interna" que torna o
 * time independente do Slack. TODA mensagem postada por um agente (via Messenger)
 * é gravada aqui, então o painel mostra a conversa mesmo quando o Slack está
 * desligado (ou não é o canal de origem). O humano também responde por aqui.
 *
 * MVP em memória (como o board): limitado para não crescer sem fim. Persistir
 * (Redis/DB) é o próximo passo, junto com o board.
 */

export interface ConvMessage {
  /** Quem falou: nome do agente ("Malu (Head de Marketing)"), "você" ou "sistema". */
  from: string;
  text: string;
  at: string;
  /** true quando a mensagem veio do humano (painel/Slack), para estilizar diferente. */
  human?: boolean;
}

const MAX_PER_THREAD = 200;
const MAX_THREADS = 500;

const threads = new Map<string, ConvMessage[]>();

/** Import do store cacheado (dinâmico para evitar ciclo conversations↔store). */
let storeModule: Promise<typeof import("../board/store.js")> | null = null;
function store(): Promise<typeof import("../board/store.js")> {
  return (storeModule ??= import("../board/store.js"));
}

/** Anexa uma mensagem ao thread (cria se não existir). Poda o excesso. */
export function appendMessage(threadKey: string, from: string, text: string, human = false): void {
  if (!threadKey || !text) return;
  let msgs = threads.get(threadKey);
  if (!msgs) {
    msgs = [];
    threads.set(threadKey, msgs);
    // Evita crescer sem limite: descarta o thread mais antigo (ordem de inserção do Map).
    if (threads.size > MAX_THREADS) {
      const oldest = threads.keys().next().value;
      if (oldest !== undefined) threads.delete(oldest);
    }
  }
  msgs.push({ from, text, at: new Date().toISOString(), human });
  if (msgs.length > MAX_PER_THREAD) msgs.shift();
  // Persiste a thread (write-through, best-effort — não trava o fluxo).
  const snapshot = [...msgs];
  void store().then(({ conversationStore }) => conversationStore.save(threadKey, snapshot));
}

/** Restaura as conversas da persistência (Redis), se houver. Chamado no boot. */
export async function initConversations(): Promise<void> {
  const { conversationStore } = await store();
  const all = await conversationStore.loadAll();
  for (const [key, msgs] of Object.entries(all)) {
    if (!threads.has(key)) threads.set(key, msgs);
  }
}

/** Mensagens de um thread (ordem cronológica). */
export function getConversation(threadKey: string): ConvMessage[] {
  return threads.get(threadKey) ? [...threads.get(threadKey)!] : [];
}

/** Existe conversa registrada neste thread? */
export function hasConversation(threadKey: string): boolean {
  return threads.has(threadKey);
}

/**
 * Bloco de contexto da thread para INJETAR no prompt de um worker — a memória
 * compartilhada que mata a amnésia entre agentes. É o transcript em TEXTO (sem
 * tool-calls, seguro para qualquer agente consumir): tudo que a PM, a Head e as
 * especialistas já disseram, mais as respostas do humano. Vazio quando não há thread.
 */
export function threadContextBlock(threadKey: string, opts: { limit?: number } = {}): string {
  const msgs = getConversation(threadKey);
  if (!msgs.length) return "";
  const recent = msgs.slice(-(opts.limit ?? 30));
  const lines = recent.map((m) => `- ${m.human ? "Humano" : m.from}: ${m.text.replace(/\s+/g, " ").trim().slice(0, 500)}`);
  return (
    `\n\n## Contexto da thread (memória compartilhada — o que já foi dito neste fio)\n` +
    `Leia antes de agir; não repita perguntas já respondidas nem refaça trabalho já feito.\n` +
    lines.join("\n")
  );
}

/** Limpa tudo (uso em teste). */
export function resetConversations(): void {
  threads.clear();
}

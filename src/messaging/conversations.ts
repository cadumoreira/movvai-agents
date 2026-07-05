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
}

/** Mensagens de um thread (ordem cronológica). */
export function getConversation(threadKey: string): ConvMessage[] {
  return threads.get(threadKey) ? [...threads.get(threadKey)!] : [];
}

/** Existe conversa registrada neste thread? */
export function hasConversation(threadKey: string): boolean {
  return threads.has(threadKey);
}

/** Limpa tudo (uso em teste). */
export function resetConversations(): void {
  threads.clear();
}

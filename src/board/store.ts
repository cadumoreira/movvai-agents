import { Redis } from "ioredis";
import { config } from "../config.js";
import type { BoardCard } from "./board.js";
import type { ConvMessage } from "../messaging/conversations.js";

/**
 * Persistência (com REDIS_URL): board E conversas são gravados write-through
 * (best-effort) e RESTAURADOS no boot — um restart não apaga mais a história.
 * Sem Redis, memória pura (comportamento original). Uma única conexão serve os dois.
 *
 * Nota de design: aprovações/perguntas pendentes NÃO são persistidas de propósito —
 * elas amarram promises do processo morto. Com fila durável (BullMQ), o job é
 * reentregue após o restart e recria a pendência; o vigia (sweepStaleCards) marca
 * como falha o que ficou órfão.
 */

const redis: Redis | null = config.redisUrl
  ? (() => {
      const r = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: false });
      r.on("error", (err) => console.error("[redis]", err.message));
      return r;
    })()
  : null;

// ── Board ────────────────────────────────────────────────────────────────
export interface BoardStore {
  loadAll(): Promise<BoardCard[]>;
  save(card: BoardCard): void;
  remove(key: string): void;
}

const BOARD_HASH = "board:cards";

class BoardMemory implements BoardStore {
  async loadAll(): Promise<BoardCard[]> {
    return [];
  }
  save(): void {}
  remove(): void {}
}

class BoardRedis implements BoardStore {
  constructor(private readonly redis: Redis) {}
  async loadAll(): Promise<BoardCard[]> {
    const raw = await this.redis.hgetall(BOARD_HASH);
    const cards: BoardCard[] = [];
    for (const json of Object.values(raw)) {
      try {
        cards.push(JSON.parse(json) as BoardCard);
      } catch {
        /* registro corrompido: ignora */
      }
    }
    return cards;
  }
  save(card: BoardCard): void {
    void this.redis.hset(BOARD_HASH, card.key, JSON.stringify(card)).catch(() => undefined);
  }
  remove(key: string): void {
    void this.redis.hdel(BOARD_HASH, key).catch(() => undefined);
  }
}

export const boardStore: BoardStore = redis ? new BoardRedis(redis) : new BoardMemory();

// ── Conversas (thread interna do painel) ───────────────────────────────────
export interface ConversationStore {
  loadAll(): Promise<Record<string, ConvMessage[]>>;
  save(threadKey: string, messages: ConvMessage[]): void;
}

const CONV_HASH = "conv:threads";

class ConversationMemory implements ConversationStore {
  async loadAll(): Promise<Record<string, ConvMessage[]>> {
    return {};
  }
  save(): void {}
}

class ConversationRedis implements ConversationStore {
  constructor(private readonly redis: Redis) {}
  async loadAll(): Promise<Record<string, ConvMessage[]>> {
    const raw = await this.redis.hgetall(CONV_HASH);
    const out: Record<string, ConvMessage[]> = {};
    for (const [key, json] of Object.entries(raw)) {
      try {
        out[key] = JSON.parse(json) as ConvMessage[];
      } catch {
        /* registro corrompido: ignora */
      }
    }
    return out;
  }
  save(threadKey: string, messages: ConvMessage[]): void {
    void this.redis.hset(CONV_HASH, threadKey, JSON.stringify(messages)).catch(() => undefined);
  }
}

export const conversationStore: ConversationStore = redis
  ? new ConversationRedis(redis)
  : new ConversationMemory();

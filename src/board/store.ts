import { Redis } from "ioredis";
import { config } from "../config.js";
import type { BoardCard } from "./board.js";

/**
 * Persistência do board: com REDIS_URL, cada card é gravado (write-through,
 * best-effort) e o board é RESTAURADO no boot — um restart não apaga mais a
 * história das frentes. Sem Redis, memória pura (comportamento original).
 *
 * Nota de design: aprovações/perguntas pendentes NÃO são persistidas de propósito —
 * elas amarram promises do processo morto. Com fila durável (BullMQ), o job é
 * reentregue após o restart e recria a pendência; o vigia (sweepStaleCards) marca
 * como falha o que ficou órfão.
 */

export interface BoardStore {
  loadAll(): Promise<BoardCard[]>;
  save(card: BoardCard): void;
  remove(key: string): void;
}

class MemoryStore implements BoardStore {
  async loadAll(): Promise<BoardCard[]> {
    return [];
  }
  save(): void {}
  remove(): void {}
}

const HASH = "board:cards";

class RedisStore implements BoardStore {
  private redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
    this.redis.on("error", (err) => console.error("[board:redis]", err.message));
  }

  async loadAll(): Promise<BoardCard[]> {
    const raw = await this.redis.hgetall(HASH);
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
    // Best-effort: persistência não pode travar o fluxo dos agentes.
    void this.redis.hset(HASH, card.key, JSON.stringify(card)).catch(() => undefined);
  }

  remove(key: string): void {
    void this.redis.hdel(HASH, key).catch(() => undefined);
  }
}

export const boardStore: BoardStore = config.redisUrl ? new RedisStore(config.redisUrl) : new MemoryStore();

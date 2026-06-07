import type { ModelMessage } from "ai";
import { Redis } from "ioredis";
import { config } from "../config.js";

/**
 * Memória de conversa por thread do Slack.
 *
 * Plugável: em memória por padrão (ótimo para dev/teste); Redis quando REDIS_URL existe
 * (sobrevive a restart). Interface assíncrona para acomodar os dois.
 */
export interface ThreadMemory {
  get(threadKey: string): Promise<ModelMessage[]>;
  append(threadKey: string, ...messages: ModelMessage[]): Promise<void>;
}

export class InMemoryThreadMemory implements ThreadMemory {
  private store = new Map<string, ModelMessage[]>();
  constructor(private readonly maxMessages = 20) {}

  async get(threadKey: string): Promise<ModelMessage[]> {
    return this.store.get(threadKey) ?? [];
  }

  async append(threadKey: string, ...messages: ModelMessage[]): Promise<void> {
    const current = this.store.get(threadKey) ?? [];
    this.store.set(threadKey, [...current, ...messages].slice(-this.maxMessages));
  }
}

export class RedisThreadMemory implements ThreadMemory {
  private redis: Redis;
  constructor(
    url: string,
    private readonly maxMessages = 20,
    private readonly ttlSeconds = 86_400,
  ) {
    this.redis = new Redis(url);
  }

  private key(threadKey: string): string {
    return `mem:${threadKey}`;
  }

  async get(threadKey: string): Promise<ModelMessage[]> {
    const raw = await this.redis.get(this.key(threadKey));
    return raw ? (JSON.parse(raw) as ModelMessage[]) : [];
  }

  async append(threadKey: string, ...messages: ModelMessage[]): Promise<void> {
    const current = await this.get(threadKey);
    const next = [...current, ...messages].slice(-this.maxMessages);
    await this.redis.set(this.key(threadKey), JSON.stringify(next), "EX", this.ttlSeconds);
  }
}

/** Memória de thread conforme a config: Redis se REDIS_URL, senão em memória. */
export function createThreadMemory(): ThreadMemory {
  return config.redisUrl ? new RedisThreadMemory(config.redisUrl) : new InMemoryThreadMemory();
}

import { EventEmitter } from "node:events";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { config } from "../config.js";
import type { JobMap } from "./types.js";

/** Converte uma URL redis(s):// em opções de conexão do BullMQ. */
function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password || undefined,
    db: u.pathname && u.pathname !== "/" ? Number(u.pathname.slice(1)) : undefined,
    tls: u.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

/**
 * Fila de jobs entre agentes (delegação PM→Dev, Dev→QA).
 *
 * Abstração plugável: em processo por padrão (zero infra, ótimo para dev/teste);
 * BullMQ/Redis quando REDIS_URL está definido (durável, escala horizontal). Trocar
 * de um para outro não muda quem publica/consome — alinhado a "começar simples".
 */
export interface JobQueue {
  enqueue<K extends keyof JobMap>(name: K, data: JobMap[K]): Promise<void>;
  process<K extends keyof JobMap>(name: K, handler: (data: JobMap[K]) => Promise<void>): void;
}

class InProcessQueue implements JobQueue {
  private emitter = new EventEmitter();

  async enqueue<K extends keyof JobMap>(name: K, data: JobMap[K]): Promise<void> {
    setImmediate(() => this.emitter.emit(name, data));
  }

  process<K extends keyof JobMap>(name: K, handler: (data: JobMap[K]) => Promise<void>): void {
    this.emitter.on(name, (data: JobMap[K]) => {
      void handler(data).catch((err) => console.error(`job "${String(name)}" falhou:`, err));
    });
  }
}

class BullMQQueue implements JobQueue {
  private connection: ConnectionOptions;
  private queues = new Map<string, Queue>();

  constructor(url: string) {
    this.connection = parseRedisUrl(url);
  }

  private queueFor(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue<K extends keyof JobMap>(name: K, data: JobMap[K]): Promise<void> {
    await this.queueFor(name).add(name, data);
  }

  process<K extends keyof JobMap>(name: K, handler: (data: JobMap[K]) => Promise<void>): void {
    new Worker(
      name,
      async (job) => {
        await handler(job.data as JobMap[K]);
      },
      { connection: this.connection },
    );
  }
}

export const queue: JobQueue = config.redisUrl
  ? new BullMQQueue(config.redisUrl)
  : new InProcessQueue();

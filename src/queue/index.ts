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

export class InProcessQueue implements JobQueue {
  private emitter = new EventEmitter();
  private retries: number;
  private retryDelayMs: number;

  constructor(opts?: { retries?: number; retryDelayMs?: number }) {
    this.retries = opts?.retries ?? config.jobs.retries;
    this.retryDelayMs = opts?.retryDelayMs ?? config.jobs.retryDelayMs;
  }

  async enqueue<K extends keyof JobMap>(name: K, data: JobMap[K]): Promise<void> {
    setImmediate(() => this.emitter.emit(name, data));
  }

  process<K extends keyof JobMap>(name: K, handler: (data: JobMap[K]) => Promise<void>): void {
    this.emitter.on(name, (data: JobMap[K]) => {
      void this.runWithRetry(String(name), handler, data);
    });
  }

  /** Handler que lança (erro transiente de rede/modelo) é retentado com espera. */
  private async runWithRetry<T>(name: string, handler: (data: T) => Promise<void>, data: T): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await handler(data);
        return;
      } catch (err) {
        const last = attempt >= this.retries;
        console.error(`job "${name}" falhou (tentativa ${attempt + 1}/${this.retries + 1})${last ? " — desistindo" : ""}:`, err);
        if (last) return;
        await new Promise((r) => setTimeout(r, this.retryDelayMs));
      }
    }
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
    // Durabilidade real: job sobrevive a restart e é retentado com backoff exponencial.
    await this.queueFor(name).add(name, data, {
      attempts: 1 + config.jobs.retries,
      backoff: { type: "exponential", delay: config.jobs.retryDelayMs },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
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

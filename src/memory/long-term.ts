import { embed } from "ai";
import pg from "pg";
import { config } from "../config.js";
import { resolveEmbeddingModel } from "../models/gateway.js";

export interface Memory {
  content: string;
  score?: number;
}

/**
 * Memória de longo prazo que persiste entre sessões (decisões, contexto do projeto).
 * Plugável: Postgres+pgvector quando DATABASE_URL existe; no-op caso contrário (assim
 * o projeto roda local sem banco).
 */
export interface LongTermMemory {
  remember(agentId: string, content: string): Promise<void>;
  recall(query: string, k?: number): Promise<Memory[]>;
}

class NoopMemory implements LongTermMemory {
  async remember(): Promise<void> {
    /* memória desativada */
  }
  async recall(): Promise<Memory[]> {
    return [];
  }
}

class PgVectorMemory implements LongTermMemory {
  private pool: pg.Pool;
  private ready: Promise<void>;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url });
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS memories (
         id BIGSERIAL PRIMARY KEY,
         agent TEXT NOT NULL,
         content TEXT NOT NULL,
         embedding vector(1536),
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
  }

  private async embedText(text: string): Promise<string> {
    const { embedding } = await embed({
      model: resolveEmbeddingModel(config.embeddingModel),
      value: text,
    });
    return `[${embedding.join(",")}]`; // formato aceito pelo pgvector
  }

  async remember(agentId: string, content: string): Promise<void> {
    await this.ready;
    const vec = await this.embedText(content);
    await this.pool.query("INSERT INTO memories (agent, content, embedding) VALUES ($1, $2, $3)", [
      agentId,
      content,
      vec,
    ]);
  }

  async recall(query: string, k = 5): Promise<Memory[]> {
    await this.ready;
    const vec = await this.embedText(query);
    const res = await this.pool.query<{ content: string; score: number }>(
      `SELECT content, 1 - (embedding <=> $1) AS score
         FROM memories
         ORDER BY embedding <=> $1
         LIMIT $2`,
      [vec, k],
    );
    return res.rows.map((r) => ({ content: r.content, score: Number(r.score) }));
  }
}

export const memory: LongTermMemory = config.databaseUrl
  ? new PgVectorMemory(config.databaseUrl)
  : new NoopMemory();

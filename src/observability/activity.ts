/** Buffer em memória da atividade recente, para o painel web exibir. */

export interface ActivityEntry {
  time: string;
  kind: string;
  agent?: string;
  model?: string;
  cost?: number;
  cacheHitRate?: number;
  detail?: string;
}

const MAX = 200;
const buffer: ActivityEntry[] = [];

export function record(entry: ActivityEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();
}

export function listActivity(limit = 100): ActivityEntry[] {
  return buffer.slice(-limit).reverse();
}

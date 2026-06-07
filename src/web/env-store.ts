import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ENV_PATH = ".env";
const EXAMPLE_PATH = ".env.example";

/** Lê o `.env` como mapa chave→valor (ignora comentários e linhas em branco). */
export function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** Valor atual de uma chave (do `.env` ou do ambiente), ou "" se ausente. */
export function getValue(key: string): string {
  const fromFile = readEnvFile()[key];
  return fromFile ?? process.env[key] ?? "";
}

/** Uma chave está definida (no `.env` ou no ambiente)? */
export function isSet(key: string): boolean {
  return getValue(key).length > 0;
}

/**
 * Grava/atualiza chaves no `.env`, preservando linhas e comentários existentes.
 * Só escreve valores não-vazios (campos em branco no form não apagam o que já existe).
 */
export function updateEnvFile(updates: Record<string, string>): void {
  const entries = Object.entries(updates).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return;

  let lines: string[] = [];
  if (existsSync(ENV_PATH)) lines = readFileSync(ENV_PATH, "utf-8").split("\n");
  else if (existsSync(EXAMPLE_PATH)) lines = readFileSync(EXAMPLE_PATH, "utf-8").split("\n");

  for (const [key, value] of entries) {
    const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
    const newLine = `${key}=${value}`;
    if (idx >= 0) lines[idx] = newLine;
    else lines.push(newLine);
  }

  writeFileSync(ENV_PATH, lines.join("\n"));
}

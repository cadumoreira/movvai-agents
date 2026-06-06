import { config } from "../config.js";

/** Diretório onde o repositório vive dentro do sandbox. */
export const REPO_DIR = "/home/user/repo";

export interface RepoTarget {
  owner: string;
  repo: string;
}

/** Quebra "owner/repo" em partes, usando o repo padrão como fallback. */
export function parseRepo(repo?: string): RepoTarget {
  const full = repo || config.github.defaultRepo;
  if (!full) throw new Error("Nenhum repositório informado nem GITHUB_DEFAULT_REPO definido.");
  const [owner, name] = full.split("/");
  if (!owner || !name) throw new Error(`Repositório inválido: "${full}". Use "owner/repo".`);
  return { owner, repo: name };
}

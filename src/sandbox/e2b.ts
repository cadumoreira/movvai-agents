import { Sandbox } from "e2b";
import { config } from "../config.js";

/** Diretório onde o repositório é clonado dentro do sandbox. */
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

/**
 * Cria um sandbox efêmero e clona o repositório dentro dele.
 *
 * Nota de segurança (Fase 3): hoje o token entra na URL de clone dentro do sandbox.
 * O hardening previsto move isso para um credential proxy — o token nunca deve viver
 * no container do agente.
 */
export async function createRepoSandbox(target: RepoTarget): Promise<Sandbox> {
  if (!config.e2b.apiKey) throw new Error("E2B_API_KEY não configurado.");
  if (!config.github.token) throw new Error("GITHUB_TOKEN não configurado.");

  const sbx = await Sandbox.create({ apiKey: config.e2b.apiKey });
  const url = `https://x-access-token:${config.github.token}@github.com/${target.owner}/${target.repo}.git`;
  const clone = await sbx.commands.run(`git clone ${url} ${REPO_DIR}`, { timeoutMs: 120_000 });
  if (clone.exitCode !== 0) {
    await sbx.kill();
    throw new Error(`Falha ao clonar o repositório: ${clone.stderr}`);
  }

  // HARDENING (Fase 3): remove o token do remote logo após o clone, para que ele não
  // fique persistido na config do git dentro do sandbox. A escrita (commit/push) é feita
  // no host (ver src/git/committer.ts), então o sandbox não precisa mais de credencial.
  // (O clone ainda usa o token transitoriamente — eliminá-lo de vez exige um git proxy,
  // a próxima sub-etapa de hardening.)
  await sbx.commands.run(
    `git remote set-url origin https://github.com/${target.owner}/${target.repo}.git`,
    { cwd: REPO_DIR },
  );
  return sbx;
}

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
  // Identidade para os commits do agente.
  await sbx.commands.run(
    `git config user.email "dev-agent@movvai.local" && git config user.name "Dev Agent"`,
    { cwd: REPO_DIR },
  );
  return sbx;
}

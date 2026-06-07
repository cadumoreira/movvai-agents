import { config } from "../config.js";
import { setupRepoInSandbox } from "../git/fetch.js";
import { parseRepo, type RepoTarget } from "./repo.js";
import { createE2BSandbox } from "./e2b.js";
import { createDockerSandbox } from "./docker.js";
import { createLocalSandbox } from "./local.js";
import type { Sandbox } from "./types.js";

export { parseRepo, type RepoTarget } from "./repo.js";
export type { Sandbox } from "./types.js";

async function createBackend(): Promise<Sandbox> {
  switch (config.sandbox.provider) {
    case "docker":
      return createDockerSandbox();
    case "e2b":
      return createE2BSandbox();
    default:
      return createLocalSandbox(); // "local" — roda na sua máquina
  }
}

/**
 * Cria um sandbox efêmero com o repositório dentro — SEM token no sandbox.
 *
 * Backend plugável: E2B (microVM na nuvem) ou Docker (contêiner local), via
 * SANDBOX_PROVIDER (default: e2b se houver E2B_API_KEY, senão docker). O repositório é
 * injetado pelo host via tarball da GitHub API (ver src/git/fetch.ts); o token vive só
 * no host. `ref` opcional traz uma branch específica (ex.: o QA revisando o PR).
 */
export async function createRepoSandbox(
  target: RepoTarget,
  opts?: { ref?: string },
): Promise<Sandbox> {
  const sbx = await createBackend();
  try {
    await setupRepoInSandbox(sbx, target, opts?.ref);
  } catch (err) {
    await sbx.kill();
    throw err;
  }
  return sbx;
}

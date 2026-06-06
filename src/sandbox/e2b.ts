import { Sandbox } from "e2b";
import { config } from "../config.js";
import { setupRepoInSandbox } from "../git/fetch.js";
import { type RepoTarget } from "./repo.js";

// Reexporta para manter os imports existentes (../sandbox/e2b.js) funcionando.
export { REPO_DIR, parseRepo, type RepoTarget } from "./repo.js";

/**
 * Cria um sandbox efêmero com o repositório dentro — SEM token no sandbox.
 *
 * HARDENING (Fase 3.x): o repositório é injetado pelo host via tarball da GitHub API
 * (ver src/git/fetch.ts); o token vive só no host (download + commit/PR). O `ref` opcional
 * permite trazer uma branch específica (ex.: o QA revisando a branch do PR).
 *
 * Egress: o SDK do E2B só oferece liga/desliga de internet (`allowInternetAccess`). O
 * allowlist por domínio (só github/npm/pypi) é configurado no template/firewall do E2B —
 * documentado, não imposto por aqui. Como o GitHub agora é acessado pelo host, o sandbox
 * só precisa de internet para package managers/testes.
 */
export async function createRepoSandbox(
  target: RepoTarget,
  opts?: { ref?: string },
): Promise<Sandbox> {
  if (!config.e2b.apiKey) throw new Error("E2B_API_KEY não configurado.");

  const sbx = await Sandbox.create({
    apiKey: config.e2b.apiKey,
    allowInternetAccess: config.sandbox.allowInternet,
  });
  try {
    await setupRepoInSandbox(sbx, target, opts?.ref);
  } catch (err) {
    await sbx.kill();
    throw err;
  }
  return sbx;
}

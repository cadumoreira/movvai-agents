import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import type { RepoTarget } from "../sandbox/repo.js";
import type { Sandbox } from "../sandbox/types.js";

/**
 * HARDENING (Fase 3.x): coloca o repositório no sandbox SEM token.
 *
 * O host baixa um tarball via GitHub API (com o token, que nunca sai do host), envia o
 * arquivo para o sandbox e o extrai lá. Em seguida inicializa um baseline git local (sem
 * remote, sem credencial) para o agente conseguir diffar suas mudanças. Substitui o
 * `git clone` com URL tokenizada — agora o token não entra no sandbox nem para leitura.
 */
export async function setupRepoInSandbox(
  sandbox: Sandbox,
  target: RepoTarget,
  ref?: string,
): Promise<{ ref: string }> {
  if (!config.github.token) throw new Error("GITHUB_TOKEN não configurado.");
  const octokit = new Octokit({ auth: config.github.token });
  const { owner, repo } = target;

  let resolvedRef = ref;
  if (!resolvedRef) {
    const { data: info } = await octokit.rest.repos.get({ owner, repo });
    resolvedRef = info.default_branch;
  }

  // Baixa o tarball no host (token usado só aqui).
  const archive = await octokit.rest.repos.downloadTarballArchive({ owner, repo, ref: resolvedRef });
  const bytes = Buffer.from(archive.data as ArrayBuffer);

  // Envia para o sandbox e extrai (o tarball do GitHub tem um diretório raiz extra).
  const dir = sandbox.repoDir;
  const tgz = `${dir}.tgz`;
  await sandbox.writeBytes(tgz, bytes);
  const setup = await sandbox.run(
    [
      `mkdir -p ${dir}`,
      `tar -xzf ${tgz} -C ${dir} --strip-components=1`,
      `rm -f ${tgz}`,
      `cd ${dir}`,
      `git init -q`,
      `git config user.email "agent@movvai.local"`,
      `git config user.name "Movvai Agent"`,
      `git add -A`,
      `git commit -q -m baseline`,
    ].join(" && "),
    { timeoutMs: 120_000 },
  );
  if (setup.exitCode !== 0) {
    throw new Error(`Falha ao preparar o repositório no sandbox: ${setup.stderr}`);
  }

  return { ref: resolvedRef };
}

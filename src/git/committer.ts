import { Octokit } from "@octokit/rest";
import type { Sandbox } from "e2b";
import { config } from "../config.js";
import { REPO_DIR, type RepoTarget } from "../sandbox/e2b.js";

/**
 * HARDENING (Fase 3): o token NUNCA entra no sandbox para escrita.
 *
 * O sandbox apenas produz as mudanças (git add + name-status + conteúdo dos arquivos).
 * O commit e o PR são criados aqui no HOST, via GitHub Git Data API, usando o token que
 * vive só no orquestrador. Substitui o antigo `git push` com remote tokenizado dentro do
 * sandbox — eliminando o caminho mais sensível de vazamento de credencial.
 */
export async function commitAndOpenPR(opts: {
  sandbox: Sandbox;
  target: RepoTarget;
  branch: string;
  title: string;
  body: string;
}): Promise<{ url: string; number: number }> {
  const { sandbox, target, branch, title, body } = opts;
  if (!config.github.token) throw new Error("GITHUB_TOKEN não configurado.");
  const octokit = new Octokit({ auth: config.github.token });
  const { owner, repo } = target;

  // 1. Coleta as mudanças dentro do sandbox (sem credencial).
  await sandbox.commands.run("git add -A", { cwd: REPO_DIR });
  const status = await sandbox.commands.run("git diff --cached --name-status", { cwd: REPO_DIR });
  const entries = parseNameStatus(status.stdout);
  if (entries.length === 0) throw new Error("Nenhuma mudança para commitar.");

  // 2. Base: ref + tree da branch default.
  const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo });
  const base = repoInfo.default_branch;
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` });
  const baseSha = ref.object.sha;
  const { data: baseCommit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: baseSha });

  // 3. Monta a árvore: blobs para arquivos add/mod; sha null para deletados.
  const tree: TreeEntry[] = [];
  for (const e of entries) {
    if (e.op === "D") {
      tree.push({ path: e.path, mode: "100644", type: "blob", sha: null });
    } else {
      const content = await sandbox.files.read(`${REPO_DIR}/${e.path}`);
      const blob = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: Buffer.from(content, "utf-8").toString("base64"),
        encoding: "base64",
      });
      tree.push({ path: e.path, mode: "100644", type: "blob", sha: blob.data.sha });
    }
  }

  // 4. Cria árvore, commit e a branch (ref) — tudo no host.
  const newTree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree,
  });
  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: title,
    tree: newTree.data.sha,
    parents: [baseSha],
  });
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: commit.data.sha,
  });

  // 5. Abre o PR.
  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    head: branch,
    base,
    title,
    body,
  });
  return { url: pr.html_url, number: pr.number };
}

interface TreeEntry {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string | null;
}

interface Change {
  op: "A" | "M" | "D";
  path: string;
}

/** Parseia a saída de `git diff --cached --name-status` em mudanças (rename = del+add). */
export function parseNameStatus(out: string): Change[] {
  const changes: Change[] = [];
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\t+/);
    if (parts.length < 2) continue;
    const code = parts[0];
    if (code.startsWith("R") && parts.length >= 3) {
      changes.push({ op: "D", path: parts[1] });
      changes.push({ op: "A", path: parts[2] });
    } else if (code === "A" || code === "M" || code === "D") {
      changes.push({ op: code, path: parts[1] });
    }
  }
  return changes;
}

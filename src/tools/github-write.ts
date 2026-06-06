import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import type { RepoTarget } from "../sandbox/e2b.js";

/** Abre um Pull Request da branch `head` contra a branch default do repo. */
export async function openPullRequest(
  target: RepoTarget,
  opts: { head: string; title: string; body: string },
): Promise<{ url: string; number: number }> {
  if (!config.github.token) throw new Error("GITHUB_TOKEN não configurado.");
  const octokit = new Octokit({ auth: config.github.token });

  const { data: repoInfo } = await octokit.rest.repos.get({
    owner: target.owner,
    repo: target.repo,
  });

  const { data: pr } = await octokit.rest.pulls.create({
    owner: target.owner,
    repo: target.repo,
    head: opts.head,
    base: repoInfo.default_branch,
    title: opts.title,
    body: opts.body,
  });

  return { url: pr.html_url, number: pr.number };
}

/** Comenta num PR (usado pelo QA para registrar a revisão). */
export async function commentOnPullRequest(
  target: RepoTarget,
  prNumber: number,
  body: string,
): Promise<void> {
  if (!config.github.token) throw new Error("GITHUB_TOKEN não configurado.");
  const octokit = new Octokit({ auth: config.github.token });
  await octokit.rest.issues.createComment({
    owner: target.owner,
    repo: target.repo,
    issue_number: prNumber,
    body,
  });
}

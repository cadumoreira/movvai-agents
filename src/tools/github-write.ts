import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import type { RepoTarget } from "../sandbox/e2b.js";

/** Abre um Pull Request da branch `head` contra a branch default do repo. */
export async function openPullRequest(
  target: RepoTarget,
  opts: { head: string; title: string; body: string },
): Promise<string> {
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

  return pr.html_url;
}

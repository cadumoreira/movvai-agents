/** Payloads dos jobs trocados entre agentes (handoffs). */

export interface DevTaskRequested {
  channel: string;
  threadTs: string;
  threadKey: string;
  ticket: { identifier?: string; url?: string; title: string };
  instructions: string;
  repo?: string;
}

export interface QaReviewRequested {
  channel: string;
  threadTs: string;
  threadKey: string;
  repo: string;
  branch: string;
  prUrl: string;
  prNumber: number;
  title: string;
}

export interface JobMap {
  "dev-task": DevTaskRequested;
  "qa-review": QaReviewRequested;
}

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

export interface DeliverySummaryRequested {
  channel: string;
  threadTs: string;
  threadKey: string;
  title: string;
  prUrl: string;
  prNumber: number;
  qaApproved?: boolean;
  ticketIdentifier?: string;
}

export interface JobMap {
  "techlead-task": DevTaskRequested;
  "dev-task": DevTaskRequested;
  "qa-review": QaReviewRequested;
  "delivery-summary": DeliverySummaryRequested;
}

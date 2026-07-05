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

/** Disciplinas do squad de marketing (cada uma tem uma persona especialista). */
export type MarketingDiscipline = "conteudo" | "social" | "ads" | "seo";

/** Disciplinas do squad de OPERAÇÕES: vendas, atendimento e financeiro. */
export type OpsDiscipline = "sdr" | "suporte" | "financeiro";

export interface OpsTaskRequested {
  channel: string;
  threadTs: string;
  threadKey: string;
  discipline: OpsDiscipline;
  title: string;
  instructions: string;
}

export interface MarketingTaskRequested {
  channel: string;
  threadTs: string;
  threadKey: string;
  brief: { title: string; url?: string; pageId?: string };
  instructions: string;
}

export interface MarketingWorkRequested {
  channel: string;
  threadTs: string;
  threadKey: string;
  discipline: MarketingDiscipline;
  brief: { title: string; url?: string; pageId?: string };
  instructions: string;
}

/** Tarefa genérica da Delivery (ex.: compilar changelog) — sem PR específico. */
export interface DeliveryTaskRequested {
  channel: string;
  threadTs: string;
  threadKey: string;
  title: string;
  instructions: string;
}

export interface JobMap {
  "techlead-task": DevTaskRequested;
  "dev-task": DevTaskRequested;
  "qa-review": QaReviewRequested;
  "delivery-summary": DeliverySummaryRequested;
  "delivery-task": DeliveryTaskRequested;
  "marketing-task": MarketingTaskRequested;
  "marketing-work": MarketingWorkRequested;
  "ops-task": OpsTaskRequested;
}

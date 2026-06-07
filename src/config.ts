import "dotenv/config";

/** Lê uma env var obrigatória; lança erro claro se faltar (só quando acessada). */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

/**
 * Config com acesso preguiçoso (getters) para as chaves obrigatórias: importar a
 * config não lança erro — só lança quando você de fato usa aquela integração. Isso
 * permite, por exemplo, rodar o smoke test do PM sem ter as chaves do Slack.
 */
export const config = {
  models: {
    pm: optional("PM_MODEL", "anthropic:claude-sonnet-4-6"),
    dev: optional("DEV_MODEL", "anthropic:claude-opus-4-8"),
    qa: optional("QA_MODEL", "anthropic:claude-sonnet-4-6"),
    // Modelo barato para tarefas simples (roteamento de custo por tier).
    cheap: optional("CHEAP_MODEL", "anthropic:claude-haiku-4-5"),
    gatewayBaseUrl: optional("MODEL_GATEWAY_BASE_URL"),
    gatewayApiKey: optional("MODEL_GATEWAY_API_KEY"),
  },
  // Orçamento de tokens por execução de agente (guarda de custo). 0 = sem limite.
  tokenBudget: Number(optional("AGENT_TOKEN_BUDGET", "400000")),
  // Conselho multi-modelo (debate/MoA) para decisões de alto valor. Vazio/1 modelo = desligado.
  council: {
    models: optional("COUNCIL_MODELS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    synthModel: optional("COUNCIL_SYNTH_MODEL"),
  },
  redisUrl: optional("REDIS_URL"),
  dashboard: {
    port: Number(optional("DASHBOARD_PORT", "3000")),
  },
  audit: {
    get path() {
      return optional("AUDIT_LOG_PATH", "audit.log");
    },
  },
  security: {
    // Quem pode aprovar via Slack (user IDs). Vazio = qualquer um (compat/local).
    approverSlackIds: optional("APPROVER_SLACK_IDS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Token exigido para aprovar pelo painel. Vazio = aberto (local).
    get dashboardToken() {
      return optional("DASHBOARD_TOKEN");
    },
    // Identificador da organização (fundação para multi-org; tagueia a auditoria).
    orgId: optional("ORG_ID", "default"),
  },
  // Memória de longo prazo (Postgres + pgvector). Vazio = memória desativada (no-op).
  databaseUrl: optional("DATABASE_URL"),
  embeddingModel: optional("EMBEDDING_MODEL", "openai:text-embedding-3-small"),
  e2b: {
    get apiKey() {
      return optional("E2B_API_KEY");
    },
  },
  // Modelos locais via Ollama (API OpenAI-compatible). Use "ollama:llama3.1" como modelo.
  ollama: {
    baseUrl: optional("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
  },
  // Manus: agente externo de tarefas assíncronas (NÃO é um modelo de chat).
  manus: {
    get apiKey() {
      return optional("MANUS_API_KEY");
    },
    baseUrl: optional("MANUS_BASE_URL", "https://api.manus.ai/v1"),
  },
  sandbox: {
    // Liga/desliga internet no sandbox (controle real do E2B). O allowlist por domínio
    // (github/npm/pypi) é configurado no template/firewall do E2B. Default: ligado, pois
    // package managers/testes precisam de rede (o GitHub já é acessado pelo host).
    allowInternet: optional("SANDBOX_ALLOW_INTERNET", "true") !== "false",
  },
  slack: {
    get botToken() {
      return required("SLACK_BOT_TOKEN");
    },
    get appToken() {
      return required("SLACK_APP_TOKEN");
    },
    get signingSecret() {
      return required("SLACK_SIGNING_SECRET");
    },
    // Canal para onde o time reporta quando o trabalho vem de webhook (sem thread do Slack).
    defaultChannel: optional("SLACK_DEFAULT_CHANNEL"),
  },
  linear: {
    get apiKey() {
      return required("LINEAR_API_KEY");
    },
    get teamKey() {
      return optional("LINEAR_TEAM_KEY");
    },
  },
  github: {
    get token() {
      return optional("GITHUB_TOKEN");
    },
    get defaultRepo() {
      return optional("GITHUB_DEFAULT_REPO");
    },
    get webhookSecret() {
      return optional("GITHUB_WEBHOOK_SECRET");
    },
  },
  // Webhooks de entrada: label que aciona o time, e segredo do Linear.
  webhooks: {
    triggerLabel: optional("AGENT_TRIGGER_LABEL", "agent"),
    get linearSecret() {
      return optional("LINEAR_WEBHOOK_SECRET");
    },
  },
};

export type Config = typeof config;

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

/** Env numérica validada: valor inválido (ex.: JOB_RETRIES=abc) cai no default, nunca em NaN. */
function numeric(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
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
    // Squad de marketing (Head + especialistas). Roteado por custo como os demais.
    marketing: optional("MARKETING_MODEL", "anthropic:claude-sonnet-4-6"),
    // Squad de operações (Igor/Lia/Otto): texto humano, não exige o topo.
    ops: optional("OPS_MODEL", "anthropic:claude-sonnet-4-6"),
    // Modelo barato para tarefas simples (roteamento de custo por tier).
    cheap: optional("CHEAP_MODEL", "anthropic:claude-haiku-4-5"),
    gatewayBaseUrl: optional("MODEL_GATEWAY_BASE_URL"),
    gatewayApiKey: optional("MODEL_GATEWAY_API_KEY"),
  },
  // Orçamento de tokens por execução de agente (guarda de custo). 0 = sem limite.
  tokenBudget: numeric("AGENT_TOKEN_BUDGET", 400_000),
  // Conselho multi-modelo (debate/MoA) para decisões de alto valor. Vazio/1 modelo = desligado.
  council: {
    models: optional("COUNCIL_MODELS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    synthModel: optional("COUNCIL_SYNTH_MODEL"),
  },
  redisUrl: optional("REDIS_URL"),
  // Robustez dos jobs: retentativas com backoff, e vigia de cards órfãos no board.
  jobs: {
    retries: numeric("JOB_RETRIES", 1),
    retryDelayMs: numeric("JOB_RETRY_DELAY_MS", 30_000),
    // Card parado em fila/execução além disso vira falha (0 = vigia desligado).
    staleCardMinutes: numeric("STALE_CARD_MINUTES", 30),
    // Aprovação/pergunta esperando você além disso ganha lembrete na thread (0 = off).
    approvalReminderMinutes: numeric("APPROVAL_REMINDER_MINUTES", 30),
  },
  dashboard: {
    port: numeric("DASHBOARD_PORT", 3000),
  },
  audit: {
    get path() {
      return optional("AUDIT_LOG_PATH", "audit.log");
    },
  },
  billing: {
    get path() {
      return optional("BILLING_LOG_PATH", "billing.log");
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
  // Skills: playbooks em Markdown carregados sob demanda pelos agentes (skills/<papel>/*.md).
  get skillsDir() {
    return optional("SKILLS_DIR", "skills");
  },
  // Brand Center: contexto da empresa em todo fluxo (brand/perfil.md + docs + assets).
  get brandDir() {
    return optional("BRAND_DIR", "brand");
  },
  // Rotinas agendadas (cron) — arquivo JSON relido a cada tick; ausente = sem rotinas.
  get schedulesPath() {
    return optional("SCHEDULES_PATH", "schedules.json");
  },
  // Templates de demanda cross-squad (templates/*.json, lidos ao vivo).
  get templatesDir() {
    return optional("TEMPLATES_DIR", "templates");
  },
  // Revisora de marketing (Vera) valida entregáveis contra os playbooks antes do humano.
  marketingReview: optional("MARKETING_REVIEW", "on") !== "off",
  // Publicação real (pós-aprovação): blog, e-mail e social/automação via webhook.
  publish: {
    wordpress: {
      get baseUrl() {
        return optional("WORDPRESS_BASE_URL");
      },
      get username() {
        return optional("WORDPRESS_USERNAME");
      },
      get appPassword() {
        return optional("WORDPRESS_APP_PASSWORD");
      },
      // Segurança: entra como rascunho por padrão; "publish" vai ao ar direto.
      get status() {
        return optional("WORDPRESS_STATUS", "draft");
      },
    },
    resend: {
      get apiKey() {
        return optional("RESEND_API_KEY");
      },
      get from() {
        return optional("EMAIL_FROM");
      },
      get to() {
        return optional("EMAIL_TO")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      },
    },
    get webhookUrl() {
      return optional("PUBLISH_WEBHOOK_URL");
    },
    get logPath() {
      return optional("PUBLICATIONS_LOG_PATH", "publications.log");
    },
  },
  // Assets visuais (criativos gerados): pasta local, servida pelo painel em /assets.
  assets: {
    get dir() {
      return optional("ASSETS_DIR", "assets");
    },
    get publicBaseUrl() {
      return optional("PUBLIC_BASE_URL");
    },
  },
  // Google (GA4 + Search Console) via service account — métricas pós-campanha da Nina.
  google: {
    get serviceAccountJson() {
      return optional("GOOGLE_SERVICE_ACCOUNT_JSON"); // caminho do .json OU o JSON inline
    },
    get ga4PropertyId() {
      return optional("GA4_PROPERTY_ID");
    },
    get gscSiteUrl() {
      return optional("GSC_SITE_URL");
    },
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
    // Backend: "local" (roda na sua máquina), "docker" (contêiner local) ou "e2b" (microVM
    // na nuvem). Default: e2b se houver E2B_API_KEY, senão local.
    get provider() {
      return optional("SANDBOX_PROVIDER") || (process.env.E2B_API_KEY ? "e2b" : "local");
    },
    // Imagem usada pelo backend Docker (precisa ter git + bash + tar; node:22 já tem).
    dockerImage: optional("SANDBOX_DOCKER_IMAGE", "node:22"),
    // Liga/desliga internet no sandbox. No Docker, "false" usa --network none. No E2B,
    // controla allowInternetAccess. Default ligado (package managers/testes precisam).
    allowInternet: optional("SANDBOX_ALLOW_INTERNET", "true") !== "false",
  },
  slack: {
    // Slack é OPCIONAL: sem as três chaves, o time roda só pelo painel + webhooks + rotinas.
    get enabled() {
      return Boolean(
        process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN && process.env.SLACK_SIGNING_SECRET,
      );
    },
    get botToken() {
      return optional("SLACK_BOT_TOKEN");
    },
    get appToken() {
      return optional("SLACK_APP_TOKEN");
    },
    get signingSecret() {
      return optional("SLACK_SIGNING_SECRET");
    },
    // Canal para onde o time reporta quando o trabalho vem de webhook (sem thread do Slack).
    get defaultChannel() {
      return optional("SLACK_DEFAULT_CHANNEL");
    },
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
  // Notion — board do squad de marketing (briefs, calendário, rascunhos). Ativo só com a chave.
  notion: {
    get apiKey() {
      return optional("NOTION_API_KEY");
    },
    // Onde as páginas nascem: um database (item por brief) OU uma página-mãe (subpáginas).
    get databaseId() {
      return optional("NOTION_DATABASE_ID");
    },
    get parentPageId() {
      return optional("NOTION_PARENT_PAGE_ID");
    },
  },
  // Jira (alternativa/adicional ao Linear). Ativo só com base/email/token/projeto.
  jira: {
    // ex.: https://suaorg.atlassian.net
    get baseUrl() {
      return optional("JIRA_BASE_URL");
    },
    get email() {
      return optional("JIRA_EMAIL");
    },
    get apiToken() {
      return optional("JIRA_API_TOKEN");
    },
    get projectKey() {
      return optional("JIRA_PROJECT_KEY");
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

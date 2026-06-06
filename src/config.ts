import "dotenv/config";

/** Lê uma env var obrigatória; lança erro claro se faltar. */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  models: {
    pm: optional("PM_MODEL", "anthropic:claude-sonnet-4-6"),
    dev: optional("DEV_MODEL", "anthropic:claude-opus-4-8"),
    gatewayBaseUrl: optional("MODEL_GATEWAY_BASE_URL"),
    gatewayApiKey: optional("MODEL_GATEWAY_API_KEY"),
  },
  e2b: {
    apiKey: optional("E2B_API_KEY"),
  },
  slack: {
    botToken: required("SLACK_BOT_TOKEN"),
    appToken: required("SLACK_APP_TOKEN"),
    signingSecret: required("SLACK_SIGNING_SECRET"),
  },
  linear: {
    apiKey: required("LINEAR_API_KEY"),
    teamKey: optional("LINEAR_TEAM_KEY"),
  },
  github: {
    token: optional("GITHUB_TOKEN"),
    defaultRepo: optional("GITHUB_DEFAULT_REPO"),
  },
} as const;

export type Config = typeof config;

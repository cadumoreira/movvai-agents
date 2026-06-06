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
    gatewayBaseUrl: optional("MODEL_GATEWAY_BASE_URL"),
    gatewayApiKey: optional("MODEL_GATEWAY_API_KEY"),
  },
  e2b: {
    get apiKey() {
      return optional("E2B_API_KEY");
    },
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
  },
};

export type Config = typeof config;

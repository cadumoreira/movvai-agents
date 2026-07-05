import { config } from "../config.js";
import { brandProfile } from "../brand/context.js";
import { hasSkills } from "../tools/skills.js";
import type { MarketingDiscipline } from "../queue/types.js";

/**
 * Preflight de dependências: TODO trabalho tem dependências (conhecimento da empresa,
 * procedimento, insumos da tarefa, integrações). Antes de o agente começar, o worker
 * verifica deterministicamente o que existe para AQUELE tipo de trabalho e entrega o
 * mapa no prompt — o agente usa o que há, degrada com aviso no que falta (opcional)
 * e NUNCA descobre a ausência quebrando no meio.
 *
 * Generaliza o Brand Center: mesma ideia para integrações, skills e afins.
 */

export type WorkKind = "techlead" | "dev" | "qa" | "marketing-lead" | MarketingDiscipline;

export interface DependencyCheck {
  id: string;
  label: string;
  ok: boolean;
  /** true = sem isso o trabalho não sai; false = degrada com aviso. */
  required: boolean;
  /** O que fazer a respeito (config a preencher ou comportamento degradado). */
  hint: string;
}

const check = (id: string, label: string, ok: boolean, required: boolean, hint: string): DependencyCheck => ({
  id,
  label,
  ok,
  required,
  hint,
});

function commonBrand(agentId: string): DependencyCheck[] {
  return [
    check(
      "brand",
      "Contexto da marca (brand/perfil.md)",
      brandProfile() !== null,
      false,
      "preencha brand/perfil.md; sem ele, pergunte tom/posicionamento em vez de assumir",
    ),
    check(
      "skills",
      "Playbooks do papel (skills/)",
      hasSkills(agentId),
      false,
      "sem playbook, siga o brief e as convenções do prompt",
    ),
  ];
}

function notionCheck(): DependencyCheck {
  const ok = Boolean(config.notion.apiKey) && Boolean(config.notion.databaseId || config.notion.parentPageId);
  return check("notion", "Notion (board do marketing)", ok, false, "sem Notion, entregue o material na thread e avise");
}

/** Mapa de dependências por tipo de trabalho. Determinístico e testável. */
export function preflight(kind: WorkKind): DependencyCheck[] {
  switch (kind) {
    case "techlead":
    case "qa":
      return [
        check("github", "GitHub (ler repositório)", Boolean(config.github.token), true, "defina GITHUB_TOKEN"),
        check(
          "tickets",
          "Tickets (Linear ou Jira)",
          Boolean(process.env.LINEAR_API_KEY) || Boolean(config.jira.baseUrl && config.jira.projectKey),
          false,
          "sem tracker, registre o design/veredito só na thread",
        ),
        ...commonBrand(kind),
      ];
    case "dev":
      return [
        check("github", "GitHub (repo + PR)", Boolean(config.github.token), true, "defina GITHUB_TOKEN"),
        check(
          "sandbox",
          `Sandbox (${config.sandbox.provider})`,
          config.sandbox.provider !== "e2b" || Boolean(config.e2b.apiKey),
          true,
          "sandbox e2b exige E2B_API_KEY (ou use SANDBOX_PROVIDER=local)",
        ),
        ...commonBrand("dev"),
      ];
    case "marketing-lead":
      return [notionCheck(), ...commonBrand("marketing-lead")];
    case "conteudo":
      return [
        notionCheck(),
        check("blog", "Publicação no blog (WordPress)", Boolean(config.publish.wordpress.baseUrl), false, "sem WordPress, o artigo aprovado fica no Notion"),
        check("email", "E-mail (Resend)", Boolean(config.publish.resend.apiKey), false, "sem Resend, não ofereça envio de e-mail"),
        check("imagem", "Geração de criativo (OPENAI_API_KEY)", Boolean(process.env.OPENAI_API_KEY), false, "sem geração, descreva o criativo em texto"),
        ...commonBrand("mkt-conteudo"),
      ];
    case "social":
    case "ads":
      return [
        notionCheck(),
        check(
          "automacao",
          "Automação de publicação (webhook)",
          Boolean(config.publish.webhookUrl),
          false,
          "sem automação, o material aprovado fica no Notion — avise que a publicação é manual",
        ),
        check("imagem", "Geração de criativo (OPENAI_API_KEY)", Boolean(process.env.OPENAI_API_KEY), false, "sem geração, descreva o criativo em texto"),
        ...commonBrand(kind === "social" ? "mkt-social" : "mkt-ads"),
      ];
    case "seo":
      return [
        notionCheck(),
        check(
          "analytics",
          "GA4/Search Console (service account)",
          Boolean(config.google.serviceAccountJson) && Boolean(config.google.ga4PropertyId || config.google.gscSiteUrl),
          false,
          "sem analytics, diga explicitamente que o relatório é qualitativo — nunca invente número",
        ),
        ...commonBrand("mkt-seo"),
      ];
  }
}

/** Dependências essenciais ausentes (o worker avisa a thread e não roda às cegas). */
export function missingRequired(checks: DependencyCheck[]): DependencyCheck[] {
  return checks.filter((c) => c.required && !c.ok);
}

/**
 * Bloco para o prompt inicial do agente: o mapa do que existe e como degradar.
 * O agente começa SABENDO o terreno — em vez de descobrir a ausência quebrando.
 */
export function formatPreflight(checks: DependencyCheck[]): string {
  if (!checks.length) return "";
  const lines = checks.map((c) => `- [${c.ok ? "ok" : "FALTA"}] ${c.label}${c.ok ? "" : ` → ${c.hint}`}`);
  return (
    `\n\n## Dependências desta frente (verificadas agora)\n${lines.join("\n")}\n` +
    `Use o que está ok. Para o que FALTA: siga a instrução de degradação e avise no resultado — ` +
    `não tente usar ferramenta ausente nem invente o que dependeria dela. ` +
    `Insumo da TAREFA faltando (público, prazo, orçamento)? Use ask_clarification (se disponível).`
  );
}

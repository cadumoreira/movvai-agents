import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "../agents/context.js";
import { queue } from "../queue/index.js";
import { track } from "../board/board.js";
import { audit } from "../audit/log.js";
import { config } from "../config.js";
import type { MarketingDiscipline } from "../queue/types.js";

/**
 * Orquestração CROSS-SQUAD: um template de demanda dispara os DOIS squads
 * coordenados na MESMA thread — ex.: "lançamento de feature" = Rui/Téo implementam
 * E a Malu prepara o anúncio, lado a lado no board. O portão de aprovação humana é
 * o sincronizador natural: nada é publicado antes do seu OK, então o anúncio nunca
 * sai antes da feature.
 *
 * Templates são JSON em templates/*.json (lidos ao vivo — crie o seu sem redeploy).
 * "{demanda}" nas instruções é substituído pelo pedido concreto.
 */

const TARGETS = ["produto", "marketing", "delivery", "conteudo", "social", "ads", "seo"] as const;
export type TemplateTarget = (typeof TARGETS)[number];

export interface DemandTemplate {
  id: string;
  name: string;
  description: string;
  steps: Array<{ target: TemplateTarget; instructions: string }>;
}

/** Valida um objeto de template; devolve o template ou o erro. */
export function validateTemplate(id: string, obj: unknown): { template?: DemandTemplate; error?: string } {
  const t = obj as Partial<DemandTemplate> & { steps?: Array<{ target?: string; instructions?: string }> };
  if (!t?.name || !t.description || !Array.isArray(t.steps) || t.steps.length === 0) {
    return { error: `template "${id}": faltam name/description/steps` };
  }
  for (const s of t.steps) {
    if (!s.target || !TARGETS.includes(s.target as TemplateTarget)) {
      return { error: `template "${id}": target inválido "${s.target}"` };
    }
    if (!s.instructions) return { error: `template "${id}": step sem instructions` };
  }
  return { template: { id, name: t.name, description: t.description, steps: t.steps as DemandTemplate["steps"] } };
}

/** Todos os templates válidos de templates/ (lidos ao vivo). */
export function listTemplates(baseDir?: string): DemandTemplate[] {
  const dir = baseDir ?? config.templatesDir;
  if (!existsSync(dir)) return [];
  const out: DemandTemplate[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const { template, error } = validateTemplate(basename(file, ".json"), JSON.parse(readFileSync(join(dir, file), "utf-8")));
      if (template) out.push(template);
      else console.warn(`[templates] ${error}`);
    } catch {
      console.warn(`[templates] ${file}: JSON inválido`);
    }
  }
  return out;
}

/** Substitui {demanda} nas instruções do template. */
export function renderStep(instructions: string, demand: string): string {
  return instructions.replaceAll("{demanda}", demand);
}

const STEP_AGENT: Record<TemplateTarget, { agent: string; squad: "produto" | "marketing"; suffix: string }> = {
  produto: { agent: "Rui (Tech Lead)", squad: "produto", suffix: "techlead" },
  marketing: { agent: "Malu (Head de Marketing)", squad: "marketing", suffix: "marketing-lead" },
  delivery: { agent: "Dani (Delivery)", squad: "produto", suffix: "delivery-task" },
  conteudo: { agent: "Caio (Conteúdo)", squad: "marketing", suffix: "mkt-conteudo" },
  social: { agent: "Sofia (Social)", squad: "marketing", suffix: "mkt-social" },
  ads: { agent: "Leo (Performance)", squad: "marketing", suffix: "mkt-ads" },
  seo: { agent: "Nina (SEO & Analytics)", squad: "marketing", suffix: "mkt-seo" },
};

/** Dispara todos os passos do template na MESMA thread (cards lado a lado no board). */
export async function fireTemplate(
  t: DemandTemplate,
  ctx: { channel: string; threadTs: string; threadKey: string },
  demand: string,
): Promise<TemplateTarget[]> {
  const base = { channel: ctx.channel, threadTs: ctx.threadTs, threadKey: ctx.threadKey };
  const title = `${t.name}: ${demand.slice(0, 60)}`;

  for (const step of t.steps) {
    const meta = STEP_AGENT[step.target];
    const instructions = renderStep(step.instructions, demand);
    // Limite conhecido: dois steps do MESMO target dividem o card no board (a key é
    // por disciplina, e o worker recalcula a mesma key). Corrigir = levar cardKey no
    // payload do job, ponta a ponta — fica para uma mudança dedicada.
    track(
      `${ctx.threadKey}:${meta.suffix}`,
      { title, agent: meta.agent, squad: meta.squad, column: "fila" },
      `template "${t.name}" acionado`,
    );
    if (step.target === "produto") {
      await queue.enqueue("techlead-task", { ...base, ticket: { title }, instructions });
    } else if (step.target === "marketing") {
      await queue.enqueue("marketing-task", { ...base, brief: { title }, instructions });
    } else if (step.target === "delivery") {
      await queue.enqueue("delivery-task", { ...base, title, instructions });
    } else {
      await queue.enqueue("marketing-work", {
        ...base,
        discipline: step.target as MarketingDiscipline,
        brief: { title },
        instructions,
      });
    }
  }
  audit({ kind: "template_fired", actor: "pm", detail: t.id, meta: { demand: demand.slice(0, 120) } });
  return t.steps.map((s) => s.target);
}

/** Ferramentas de template para a Ana (PM): listar e disparar. */
export function templateTools(ctx: AgentContext): ToolSet {
  return {
    list_templates: tool({
      description:
        "Lista os TEMPLATES de demanda cross-squad (ex.: lançamento de feature = produto implementa " +
        "E marketing prepara o anúncio, na mesma thread). Consulte quando a demanda parecer casar com um fluxo padrão.",
      inputSchema: z.object({}),
      execute: async () => ({
        templates: listTemplates().map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          squads: t.steps.map((s) => s.target),
        })),
      }),
    }),

    launch_template: tool({
      description:
        "Dispara um template cross-squad: todos os passos entram na MESMA thread, coordenados. " +
        "Use em vez de delegações manuais quando a demanda casa com um template.",
      inputSchema: z.object({
        template_id: z.string().describe("Id do template (de list_templates)."),
        demand: z.string().describe("A demanda concreta: o que está sendo lançado/feito, contexto e prazo."),
      }),
      execute: async ({ template_id, demand }) => {
        const t = listTemplates().find((x) => x.id === template_id);
        if (!t) return { ok: false, error: `Template "${template_id}" não encontrado.` };
        const targets = await fireTemplate(t, ctx, demand);
        return { ok: true, launched: targets, note: "Frentes acionadas na mesma thread — acompanhe no board." };
      },
    }),
  };
}

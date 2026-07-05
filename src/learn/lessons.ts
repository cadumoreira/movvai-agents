import { appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { config } from "../config.js";
import { audit } from "../audit/log.js";
import { memory } from "../memory/long-term.js";

/**
 * O time que APRENDE: cada recusa sua vira uma lição permanente, e cada acerto
 * elogiado vira referência. As lições moram em skills/<papel>/licoes.md e
 * referencias.md — ou seja, entram no MESMO circuito das skills: o agente as
 * carrega nas próximas execuções (e você pode curá-las pela view Playbooks).
 */

const HEADERS: Record<CuratedFile, string> = {
  licoes: `---
name: Lições aprendidas
description: Lições extraídas de recusas e resultados reais — SEMPRE consulte antes de produzir.
---

# Lições aprendidas
`,
  referencias: `---
name: Referências aprovadas
description: Exemplos que o humano aprovou/elogiou — use como norte de qualidade e estilo.
---

# Referências aprovadas
`,
};

export type CuratedFile = "licoes" | "referencias";

/** Anexa uma entrada datada ao arquivo curado do papel (cria com frontmatter na 1ª vez). */
export function appendCurated(agentId: string, file: CuratedFile, entry: string, baseDir?: string): void {
  const dir = join(baseDir ?? config.skillsDir, agentId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${file}.md`);
  if (!existsSync(path)) writeFileSync(path, HEADERS[file]);
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync(path, `\n- **${date}** — ${entry.replace(/\n+/g, " ").trim()}`);
}

/** Registra uma lição (arquivo curado + memória de longo prazo, se houver + auditoria). */
export function recordLesson(agentId: string, lesson: string, baseDir?: string): void {
  appendCurated(agentId, "licoes", lesson, baseDir);
  void memory.remember(agentId, `Lição: ${lesson}`).catch(() => undefined);
  audit({ kind: "lesson_recorded", actor: agentId, detail: lesson.slice(0, 200) });
}

/** Ferramentas de aprendizado — para o agente consolidar o que descobre sozinho. */
export function learningTools(agentId: string): ToolSet {
  return {
    record_lesson: tool({
      description:
        "Registra uma LIÇÃO permanente do papel (você a verá nas próximas execuções, em licoes.md). " +
        "Use quando aprender algo com resultado real: recusa explicada, A/B medido, padrão que funcionou/falhou. " +
        "Uma frase acionável — regra, não relato.",
      inputSchema: z.object({
        lesson: z
          .string()
          .describe('A lição como regra acionável. Ex.: "Headline com número concreto supera adjetivo para o nosso público."'),
      }),
      execute: async ({ lesson }) => {
        recordLesson(agentId, lesson);
        return { ok: true, note: "Lição gravada — será considerada nas próximas execuções." };
      },
    }),

    save_reference: tool({
      description:
        "Salva um exemplo APROVADO/elogiado como referência de qualidade do papel (referencias.md). " +
        "Use quando o humano aprovar com elogio ou um material performar bem — vira o norte de estilo.",
      inputSchema: z.object({
        title: z.string().describe("Identificação curta do exemplo."),
        excerpt: z.string().describe("O trecho essencial (não o material inteiro — só o que ensina)."),
        why: z.string().describe("Por que é bom (1 frase)."),
      }),
      execute: async ({ title, excerpt, why }) => {
        appendCurated(agentId, "referencias", `**${title}**: ${excerpt} _(por quê: ${why})_`);
        audit({ kind: "reference_saved", actor: agentId, detail: title });
        return { ok: true };
      },
    }),
  };
}

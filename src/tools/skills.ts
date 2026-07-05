import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { config } from "../config.js";

/**
 * Skills: conhecimento procedural curado (playbooks, guias, checklists) que o agente
 * carrega SOB DEMANDA — em vez de inflar o system prompt com tudo, sempre.
 *
 * Layout no disco (Markdown puro, editável sem deploy — o fs é lido a cada chamada):
 *   skills/shared/*.md       → visíveis para todos os agentes
 *   skills/<agentId>/*.md    → visíveis só para aquele papel (ex.: skills/mkt-social/)
 *
 * Frontmatter opcional (name/description); sem ele, usa o nome do arquivo e a
 * primeira linha do corpo. Complementa a memória de longo prazo: memória é o que os
 * AGENTES aprendem; skills são o que VOCÊ cura.
 */

export interface SkillMeta {
  /** Identificador para load_skill (ex.: "shared/tom-de-voz"). */
  id: string;
  name: string;
  description: string;
}

export interface ParsedSkill {
  meta: Record<string, string>;
  body: string;
}

/** Parser mínimo de frontmatter (--- chave: valor ---). Determinístico e sem dependências. */
export function parseFrontmatter(raw: string): ParsedSkill {
  const meta: Record<string, string> = {};
  if (!raw.startsWith("---")) return { meta, body: raw.trim() };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta, body: raw.trim() };
  for (const line of raw.slice(3, end).split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body: raw.slice(end + 4).trim() };
}

/** Nome de arquivo válido de skill (evita path traversal em load_skill). */
const SAFE_ID = /^[a-z0-9_-]+\/[a-z0-9._-]+$/i;

function skillsRoot(baseDir?: string): string {
  return baseDir ?? config.skillsDir;
}

function scanDir(root: string, scope: string): SkillMeta[] {
  const dir = join(root, scope);
  if (!existsSync(dir)) return [];
  const out: SkillMeta[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".md")) continue;
    try {
      const { meta, body } = parseFrontmatter(readFileSync(join(dir, file), "utf-8"));
      const firstLine = body.split("\n").find((l) => l.trim()) ?? "";
      out.push({
        id: `${scope}/${basename(file, ".md")}`,
        name: meta.name || basename(file, ".md"),
        description: meta.description || firstLine.slice(0, 120),
      });
    } catch {
      /* arquivo ilegível: ignora */
    }
  }
  return out;
}

/** Índice de skills visíveis para um agente: as compartilhadas + as do papel dele. */
export function listSkills(agentId: string, baseDir?: string): SkillMeta[] {
  const root = skillsRoot(baseDir);
  return [...scanDir(root, "shared"), ...scanDir(root, agentId)];
}

/** Conteúdo completo de uma skill (por id do índice). null se não existir/for inválida. */
export function loadSkill(agentId: string, id: string, baseDir?: string): string | null {
  if (!SAFE_ID.test(id)) return null;
  const [scope] = id.split("/");
  if (scope !== "shared" && scope !== agentId) return null; // só o escopo do próprio papel
  const path = join(skillsRoot(baseDir), `${id}.md`);
  if (!existsSync(path)) return null;
  try {
    return parseFrontmatter(readFileSync(path, "utf-8")).body;
  } catch {
    return null;
  }
}

/** Há skills para este papel? (para a dica condicional no system prompt) */
export function hasSkills(agentId: string, baseDir?: string): boolean {
  return listSkills(agentId, baseDir).length > 0;
}

/**
 * Bloco a anexar ao system prompt QUANDO o papel tem skills — assim o prompt só fala
 * de skills se elas existirem de verdade.
 */
export function skillsPromptHint(agentId: string): string {
  if (!hasSkills(agentId)) return "";
  return `

## Skills (playbooks do time)
Você tem playbooks curados para o seu papel. No início de uma tarefa, chame \`list_skills\`
e carregue com \`load_skill\` APENAS as relevantes para a tarefa — elas definem como o time
trabalha (tom, formatos, checklists) e prevalecem sobre suas suposições.`;
}

export function skillTools(agentId: string): ToolSet {
  return {
    list_skills: tool({
      description:
        "Lista os playbooks/guias curados disponíveis para o seu papel (nome + descrição). " +
        "Consulte no início da tarefa; carregue só os relevantes com load_skill.",
      inputSchema: z.object({}),
      execute: async () => ({ skills: listSkills(agentId) }),
    }),

    load_skill: tool({
      description: "Carrega o conteúdo completo de uma skill listada por list_skills (pelo id).",
      inputSchema: z.object({
        id: z.string().describe('Id da skill como veio de list_skills (ex.: "shared/tom-de-voz").'),
      }),
      execute: async ({ id }) => {
        const content = loadSkill(agentId, id);
        return content === null ? { ok: false, error: `Skill "${id}" não encontrada.` } : { ok: true, content };
      },
    }),
  };
}

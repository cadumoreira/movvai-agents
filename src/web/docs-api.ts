import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { config } from "../config.js";
import { audit } from "../audit/log.js";

/**
 * API de curadoria: listar/ler/gravar os PLAYBOOKS (skills/) e o MANUAL DA MARCA
 * (brand/) pelo painel — quem não é técnico edita o comportamento do time sem tocar
 * em arquivo/repositório. Leitura é ao vivo (os agentes usam na próxima execução).
 *
 * Escrita exige o token do painel (mesmo RBAC das aprovações) e é auditada.
 */

export interface DocRef {
  /** "skill" (skills/<escopo>/<nome>.md) ou "brand" (brand/<nome>.md). */
  type: "skill" | "brand";
  /** skill: "escopo/nome" · brand: "nome". */
  id: string;
}

const SKILL_ID = /^[a-z0-9_-]+\/[a-z0-9._-]+$/i;
const BRAND_ID = /^[a-z0-9._-]+$/i;

/** Caminho do arquivo de um doc, ou null se o id for inválido (path traversal etc.). */
export function docPath(ref: DocRef): string | null {
  if (ref.type === "skill") {
    if (!SKILL_ID.test(ref.id)) return null;
    return join(config.skillsDir, `${ref.id}.md`);
  }
  if (!BRAND_ID.test(ref.id)) return null;
  return join(config.brandDir, `${ref.id}.md`);
}

/** Índice de todos os docs editáveis (skills por escopo + brand). */
export function listDocs(): Array<DocRef & { title: string }> {
  const out: Array<DocRef & { title: string }> = [];

  if (existsSync(config.brandDir)) {
    for (const f of readdirSync(config.brandDir).sort()) {
      if (f.endsWith(".md")) out.push({ type: "brand", id: f.slice(0, -3), title: `marca / ${f.slice(0, -3)}` });
    }
  }
  if (existsSync(config.skillsDir)) {
    for (const scope of readdirSync(config.skillsDir, { withFileTypes: true })) {
      if (!scope.isDirectory()) continue;
      for (const f of readdirSync(join(config.skillsDir, scope.name)).sort()) {
        if (!f.endsWith(".md")) continue;
        const id = `${scope.name}/${f.slice(0, -3)}`;
        out.push({ type: "skill", id, title: `skill / ${id}` });
      }
    }
  }
  return out;
}

export function readDoc(ref: DocRef): string | null {
  const path = docPath(ref);
  if (!path || !existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export function writeDoc(ref: DocRef, content: string): boolean {
  const path = docPath(ref);
  if (!path) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  audit({ kind: "doc_edited", actor: "dashboard", detail: `${ref.type}:${ref.id}` });
  return true;
}

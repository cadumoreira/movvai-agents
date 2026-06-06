/** Utilitários de texto puros (sem dependências) — fáceis de testar. */

/** Gera um slug seguro para nome de branch a partir de um título. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Limita o tamanho de uma string (para conter contexto/custo). */
export function clip(s: string, max = 8_000): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncado)" : s;
}

/** Retorna o primeiro valor string não-vazio entre as chaves dadas (parsing tolerante). */
export function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * Parser mínimo de cron (5 campos: minuto hora dia-do-mês mês dia-da-semana), sem
 * dependências. Suporta: números, listas (1,3,5), intervalos (1-5), passos (*\/15,
 * 1-10/2) e * — o suficiente para rotinas de time. Determinístico e testável.
 */

/** Expande um campo de cron para o conjunto de valores permitidos. */
export function parseField(expr: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined || rangePart === "") throw new Error(`Campo de cron inválido: "${part}"`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Passo inválido em "${part}"`);

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : max; // "5/2" = a partir de 5, de 2 em 2
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Valor fora do intervalo [${min}-${max}] em "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * A expressão casa com este instante? Segue a regra clássica do cron: quando
 * dia-do-mês E dia-da-semana são restritos (≠ *), basta UM deles casar.
 */
export function matchesCron(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron deve ter 5 campos, veio ${fields.length}: "${expr}"`);
  const [m, h, dom, mon, dow] = fields;

  const minutes = parseField(m, 0, 59);
  const hours = parseField(h, 0, 23);
  const daysOfMonth = parseField(dom, 1, 31);
  const months = parseField(mon, 1, 12);
  // 0 e 7 = domingo.
  const daysOfWeek = new Set([...parseField(dow, 0, 7)].map((v) => (v === 7 ? 0 : v)));

  const domMatch = daysOfMonth.has(date.getDate());
  const dowMatch = daysOfWeek.has(date.getDay());
  const dayMatch = dom !== "*" && dow !== "*" ? domMatch || dowMatch : domMatch && dowMatch;

  return minutes.has(date.getMinutes()) && hours.has(date.getHours()) && months.has(date.getMonth() + 1) && dayMatch;
}

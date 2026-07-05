import { readFileSync, existsSync } from "node:fs";
import type { WebClient } from "@slack/web-api";
import { matchesCron } from "./cron.js";
import { queue } from "../queue/index.js";
import { track } from "../board/board.js";
import { audit } from "../audit/log.js";
import { config } from "../config.js";
import type { MarketingDiscipline } from "../queue/types.js";

/**
 * Rotinas agendadas: o time trabalha PROATIVAMENTE, não só quando provocado.
 * Definidas em um JSON (SCHEDULES_PATH, default "schedules.json"), relido a cada
 * tick — editar a rotina muda o comportamento sem redeploy (mesmo padrão das skills).
 *
 * Cada rotina posta uma mensagem-âncora no canal e enfileira o job do alvo:
 *   "marketing"                      → Malu planeja (marketing-task)
 *   "conteudo"|"social"|"ads"|"seo"  → especialista direto (marketing-work)
 *   "produto"                        → Rui desenha e delega (techlead-task)
 */

const DISCIPLINES: MarketingDiscipline[] = ["conteudo", "social", "ads", "seo"];
export type ScheduleTarget = "marketing" | "produto" | MarketingDiscipline;

export interface Schedule {
  name: string;
  cron: string;
  target: ScheduleTarget;
  instructions: string;
  /** Canal do Slack; default SLACK_DEFAULT_CHANNEL. */
  channel?: string;
}

/** Valida o JSON de rotinas; devolve as válidas e os erros (para log). */
export function parseSchedules(raw: string): { schedules: Schedule[]; errors: string[] } {
  const schedules: Schedule[] = [];
  const errors: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { schedules, errors: ["JSON inválido"] };
  }
  if (!Array.isArray(data)) return { schedules, errors: ["esperado um array de rotinas"] };

  for (const [i, item] of data.entries()) {
    const s = item as Partial<Schedule>;
    const where = s.name ? `"${s.name}"` : `#${i}`;
    if (!s.name || !s.cron || !s.target || !s.instructions) {
      errors.push(`rotina ${where}: faltam campos (name, cron, target, instructions)`);
      continue;
    }
    if (s.target !== "marketing" && s.target !== "produto" && !DISCIPLINES.includes(s.target as MarketingDiscipline)) {
      errors.push(`rotina ${where}: target "${s.target}" inválido`);
      continue;
    }
    try {
      matchesCron(s.cron, new Date(0)); // valida a sintaxe
    } catch (err) {
      errors.push(`rotina ${where}: cron inválido (${err instanceof Error ? err.message : err})`);
      continue;
    }
    schedules.push(s as Schedule);
  }
  return { schedules, errors };
}

const SPECIALIST_LABEL: Record<MarketingDiscipline, string> = {
  conteudo: "Caio (Conteúdo)",
  social: "Sofia (Social)",
  ads: "Leo (Performance)",
  seo: "Nina (SEO & Analytics)",
};

async function fire(slack: WebClient, s: Schedule): Promise<void> {
  const channel = s.channel || config.slack.defaultChannel;
  if (!channel) {
    console.warn(`Rotina "${s.name}" ignorada: defina SLACK_DEFAULT_CHANNEL (ou "channel" na rotina).`);
    return;
  }
  const posted = await slack.chat.postMessage({
    channel,
    text: `:alarm_clock: Rotina *${s.name}* — acionando o time.`,
  });
  const threadTs = String(posted.ts);
  const threadKey = `${channel}:${threadTs}`;
  const base = { channel, threadTs, threadKey };
  audit({ kind: "schedule_fired", actor: "scheduler", detail: s.name, meta: { target: s.target } });

  if (s.target === "marketing") {
    track(`${threadKey}:marketing-lead`, { title: s.name, agent: "Malu (Head de Marketing)", squad: "marketing", column: "fila" }, "rotina agendada");
    await queue.enqueue("marketing-task", { ...base, brief: { title: s.name }, instructions: s.instructions });
  } else if (s.target === "produto") {
    track(`${threadKey}:techlead`, { title: s.name, agent: "Rui (Tech Lead)", squad: "produto", column: "fila" }, "rotina agendada");
    await queue.enqueue("techlead-task", { ...base, ticket: { title: s.name }, instructions: s.instructions });
  } else {
    track(`${threadKey}:mkt-${s.target}`, { title: s.name, agent: SPECIALIST_LABEL[s.target], squad: "marketing", column: "fila" }, "rotina agendada");
    await queue.enqueue("marketing-work", { ...base, discipline: s.target, brief: { title: s.name }, instructions: s.instructions });
  }
}

/** Sobe o agendador: relê o arquivo e checa os crons a cada meio minuto. */
export function startScheduler(slack: WebClient): void {
  const fired = new Set<string>(); // dedupe: "nome@minuto"
  const tick = async () => {
    const path = config.schedulesPath;
    if (!existsSync(path)) return;
    const { schedules, errors } = parseSchedules(readFileSync(path, "utf-8"));
    for (const e of errors) console.warn(`[scheduler] ${e}`);

    const now = new Date();
    const minute = now.toISOString().slice(0, 16);
    for (const s of schedules) {
      const key = `${s.name}@${minute}`;
      if (fired.has(key) || !matchesCron(s.cron, now)) continue;
      fired.add(key);
      if (fired.size > 1000) fired.clear(); // higiene: chaves têm o minuto, não colidem após clear
      fire(slack, s).catch((err) => console.error(`Rotina "${s.name}" falhou:`, err));
    }
  };

  setInterval(() => void tick(), 30_000);
  void tick();
  console.log(JSON.stringify({ level: "info", kind: "scheduler", path: config.schedulesPath, at: new Date().toISOString() }));
}

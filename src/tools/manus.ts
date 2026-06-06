import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { config } from "../config.js";

/**
 * Adapter do Manus como AGENTE EXTERNO (não é um modelo de chat — ver pesquisa).
 * Manus é uma API de tarefas assíncronas: cria tarefa → faz poll até concluir → coleta
 * resultado. Útil para delegar tarefas abertas/gerais (pesquisa, automações multi-step)
 * a um agente de fora do time.
 *
 * ⚠️ Endpoints/campos baseados na doc pública (api.manus.ai, header API_KEY, POST /tasks).
 * São configuráveis por env (MANUS_BASE_URL) e o parsing é tolerante — valide contra a
 * documentação oficial (https://open.manus.im/docs/api-reference) antes de produção.
 */
export function manusTools(): ToolSet {
  if (!config.manus.apiKey) return {};

  const headers = {
    "Content-Type": "application/json",
    API_KEY: config.manus.apiKey,
  };

  function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v) return v;
    }
    return undefined;
  }

  return {
    manus_run_task: tool({
      description:
        "Delega uma tarefa aberta/geral a um agente externo (Manus), que trabalha de forma assíncrona. Use para trabalho fora do código (pesquisa de mercado, automações, análises) que o time não cobre. Retorna o resultado quando a tarefa conclui.",
      inputSchema: z.object({
        instructions: z.string().describe("Descrição clara e completa da tarefa para o Manus."),
      }),
      execute: async ({ instructions }) => {
        // 1. Cria a tarefa.
        const createRes = await fetch(`${config.manus.baseUrl}/tasks`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: instructions }),
        });
        if (!createRes.ok) {
          return { ok: false, error: `Falha ao criar tarefa no Manus (${createRes.status}).` };
        }
        const created = (await createRes.json()) as Record<string, unknown>;
        const taskId = pick(created, ["id", "task_id", "taskId"]);
        if (!taskId) return { ok: false, error: "Resposta do Manus sem id de tarefa." };

        // 2. Poll até estado terminal (ou timeout ~5 min).
        const terminal = new Set(["completed", "succeeded", "failed", "stopped", "error"]);
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5_000));
          const getRes = await fetch(`${config.manus.baseUrl}/tasks/${taskId}`, { headers });
          if (!getRes.ok) continue;
          const task = (await getRes.json()) as Record<string, unknown>;
          const status = (pick(task, ["status", "state"]) ?? "").toLowerCase();
          if (terminal.has(status)) {
            const result = pick(task, ["result", "output", "answer", "summary"]);
            const url = pick(task, ["url", "task_url", "share_url"]);
            return { ok: status !== "failed" && status !== "error", status, result, url };
          }
        }
        return { ok: false, status: "timeout", taskId };
      },
    }),
  };
}

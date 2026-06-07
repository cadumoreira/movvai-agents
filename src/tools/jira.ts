import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { config } from "../config.js";
import { audit } from "../audit/log.js";

/**
 * Ferramentas do Jira (alternativa/adicional ao Linear). Ativadas só se base/email/token/
 * projeto estiverem configurados. Usa a REST API v2 (descrição em texto plano).
 *
 * ⚠️ Validar contra a sua instância (issuetype "Task", permissões do projeto) antes de produção.
 */
export function jiraTools(): ToolSet {
  const { baseUrl, email, apiToken, projectKey } = config.jira;
  if (!baseUrl || !email || !apiToken || !projectKey) return {};

  const headers = {
    "Content-Type": "application/json",
    Authorization: "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64"),
  };

  return {
    jira_create_issue: tool({
      description:
        "Cria um ticket no Jira com a demanda refinada (título + descrição com contexto, repro e critérios de aceite).",
      inputSchema: z.object({
        summary: z.string().describe("Título do ticket."),
        description: z.string().describe("Descrição (texto): contexto, passos, critérios de aceite."),
      }),
      execute: async ({ summary, description }) => {
        const res = await fetch(`${baseUrl}/rest/api/2/issue`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            fields: {
              project: { key: projectKey },
              summary,
              description,
              issuetype: { name: "Task" },
            },
          }),
        });
        if (!res.ok) return { ok: false, error: `Falha ao criar issue (${res.status}).` };
        const data = (await res.json()) as { key?: string };
        if (!data.key) return { ok: false, error: "Resposta do Jira sem key." };
        const url = `${baseUrl}/browse/${data.key}`;
        audit({ kind: "ticket_created", actor: "pm", detail: data.key, meta: { url, system: "jira" } });
        return { ok: true, identifier: data.key, url };
      },
    }),

    jira_comment: tool({
      description: "Adiciona um comentário a um ticket do Jira (por chave, ex.: PROJ-123).",
      inputSchema: z.object({ key: z.string(), body: z.string() }),
      execute: async ({ key, body }) => {
        const res = await fetch(`${baseUrl}/rest/api/2/issue/${key}/comment`, {
          method: "POST",
          headers,
          body: JSON.stringify({ body }),
        });
        return res.ok ? { ok: true, key } : { ok: false, error: `Falha ao comentar (${res.status}).` };
      },
    }),

    jira_search: tool({
      description: "Busca tickets no Jira por texto (evita duplicar demanda).",
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        const jql = encodeURIComponent(`project = ${projectKey} AND text ~ ${JSON.stringify(text)}`);
        const res = await fetch(`${baseUrl}/rest/api/2/search?jql=${jql}&maxResults=5`, { headers });
        if (!res.ok) return { results: [] };
        const data = (await res.json()) as { issues?: Array<{ key: string; fields?: { summary?: string } }> };
        return {
          results: (data.issues ?? []).map((i) => ({
            key: i.key,
            summary: i.fields?.summary,
            url: `${baseUrl}/browse/${i.key}`,
          })),
        };
      },
    }),
  };
}

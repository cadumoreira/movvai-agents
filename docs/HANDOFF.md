# Handoff — estado do projeto

> Resumo para retomar o trabalho em outra sessão. **Todo o código está no GitHub** (`main`).
> Numa nova sessão, o repo é clonado automaticamente — basta `npm install`.

## Onde estamos
- Branch `main` = `claude/epic-noether-LF2dW` (sincronizadas).
- Núcleo do produto **completo e com maturidade de produção** (testes + CI + auditoria + RBAC + billing).
- **Nunca foi executado contra Slack/E2B/Linear/GitHub reais** — só validado por typecheck + 26 testes.
  Primeiro teste real é o maior valor pendente.

## O que já existe
- **5 agentes**: PM (Ana) → Tech Lead (Rui) → Dev (Téo) → QA (Bia) → Delivery (Dani) + **conselho multi-modelo**.
- **Multi-provedor**: Anthropic, OpenAI, Google, Ollama (gateway via Vercel AI SDK) + Manus (agente externo).
- **3 gatilhos**: menção no Slack, label em issue do GitHub, label no Linear (webhooks de entrada).
- **Sandbox plugável**: `local` (na máquina, default sem E2B), `docker`, `e2b`. Token nunca entra no sandbox.
- **Aprovação humana** nos pontos-chave (Slack botões **ou** painel web).
- **Custo**: roteamento por modelo, prompt caching, orçamento de tokens, billing por org.
- **Observabilidade**: logs de custo/cache-hit + OpenTelemetry → Langfuse.
- **Painel web** (`:3000`): atividade, aprovações, auditoria, billing.
- **Backoffice** (`:4000`, `npm run backoffice`): configura tudo pela web (grava no `.env`).
- **Qualidade**: 26 testes (Node test runner), CI no GitHub Actions, harness de eval (scaffold).
- Docs: `PESQUISA-ARQUITETURA.md`, `ARQUITETURA.md`, `DECISAO-LINGUAGEM.md`.

## Como rodar (resumo)
```bash
npm install
npm run backoffice    # http://localhost:4000 — preencher chaves; ver status de prontidão
npm run try:pm -- "descrição completa do bug"   # PM cria ticket no Linear
npm run try:dev -- "tarefa"                      # Dev no sandbox (local) abre PR
npm run dev                                       # time completo no Slack + painel :3000
npm test                                          # 26 testes
```

## Pendências (backlog priorizado)
1. **Validação real** — rodar com chaves de verdade (o maior valor).
2. **Multi-tenancy plena** (config isolada por org) — hoje só `ORG_ID` tagueia.
3. **Persistência**: aprovações/atividade/billing-totais em Redis (hoje memória; audit/billing já em arquivo).
4. **MCP no perímetro** / **A2A** (interoperabilidade).
5. **GitLab**, **conselho modo debate**, mais papéis (Security/Docs), agentes agendados.
6. **RAG/indexação do codebase**, **Next.js** (upgrade do painel).

## Limitações conhecidas
- Estado volátil em memória (acima) exceto logs de auditoria/billing (JSONL).
- 1 bot no Slack (sem identidade por agente).
- Egress allowlist por domínio é config de template do E2B (não imposto no código).
- Endpoints do Manus/Jira a validar contra a doc oficial.

## ⚠️ Importante para a próxima sessão
- **O contêiner é efêmero**: o que não está no GitHub se perde. Sempre `commit` + `push` ao terminar.
- O push do contêiner exige um **PAT** (Contents+Workflows: write); ou faça o push da sua máquina.

## Como retomar
Numa nova sessão, diga ao Claude algo como:
> "Continuando o projeto movvai-agents (dream team de agentes). Leia `docs/HANDOFF.md` e `docs/ARQUITETURA.md`. Quero [próximo passo]."

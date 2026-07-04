# Handoff — estado do projeto

> Resumo para retomar o trabalho em outra sessão. **Todo o código está no GitHub** (`main`).
> Numa nova sessão, o repo é clonado automaticamente — basta `npm install`.

## Onde estamos
- Branch `main` = `claude/epic-noether-LF2dW` (sincronizadas).
- Núcleo do produto **completo e com maturidade de produção** (testes + CI + auditoria + RBAC + billing).
- **Primeiro teste real JÁ FOI FEITO e o código está validado:** o agente PM (Ana) rodou de
  verdade — a requisição chegou na Anthropic e funcionou; o único bloqueio foi **saldo da conta
  Anthropic** ("credit balance too low"). Ou seja, o pipeline está OK ponta a ponta.
- **Próximo passo imediato:** adicionar créditos na Anthropic (console → Plans & Billing) OU usar
  outro provedor com saldo, e rodar `npm run try:pm` para criar o primeiro ticket no Linear.

## Chaves já configuradas pelo usuário (no `.env` local da máquina dele)
- **Anthropic** (válida, mas conta sem créditos no momento do teste) · **Linear** (válida).
- **Faltam** (opcionais por nível): **GitHub token** (Dev abrir PR), **Slack** (time completo),
  **E2B** (só se usar sandbox na nuvem; o default é `local`).
- Tudo é configurável pelo **backoffice** (`npm run backoffice`, http://localhost:4000).

## O que já existe
- **5 agentes**: PM (Ana) → Tech Lead (Rui) → Dev (Téo) → QA (Bia) → Delivery (Dani) + **conselho multi-modelo**.
- **Squad de MARKETING** (ao lado do time de produto): Malu (Head) planeja o **brief no Notion** e
  delega por frente a Caio (conteúdo), Sofia (social), Leo (ads) e Nina (SEO/analytics). Entregáveis
  no Notion com aprovação humana antes de publicar. Ativa com `NOTION_API_KEY` + database/página-mãe.
- **Multi-provedor**: Anthropic, OpenAI, Google, Ollama (gateway via Vercel AI SDK) + Manus (agente externo).
- **3 gatilhos**: menção no Slack, label em issue do GitHub, label no Linear (webhooks de entrada).
- **Sandbox plugável**: `local` (na máquina, default sem E2B), `docker`, `e2b`. Token nunca entra no sandbox.
- **Aprovação humana** nos pontos-chave (Slack botões **ou** painel web).
- **Custo**: roteamento por modelo, prompt caching, orçamento de tokens, billing por org.
- **Observabilidade**: logs de custo/cache-hit + OpenTelemetry → Langfuse.
- **Painel web** (`:3000`): **kanban interativo** (Fila → Em atuação → Aguardando humano →
  Concluído): aprovar/recusar e responder perguntas DIRETO no card (aprovação casada por
  thread+agente), filtro por squad, busca, e **dossiê** no clique (timeline completa + decisões).
  Também: atividade, aprovações, perguntas, auditoria, billing. Demo sem chaves/custo:
  `npm run demo:board` (aprovações e pergunta da Malu reais, respondíveis pelo painel).
- **Backoffice** (`:4000`, `npm run backoffice`): configura tudo pela web (grava no `.env`).
- **Skills (playbooks)**: Markdown em `skills/shared/` (todos) e `skills/<papel>/` (por papel),
  carregado sob demanda via `list_skills`/`load_skill` — lido do disco a cada chamada (edita sem
  redeploy). Exemplos inclusos para o squad de marketing; a dica só entra no prompt se houver skill.
- **Rotinas agendadas (cron)**: `schedules.json` (parser de cron próprio, 5 campos; relido a cada
  tick). Targets: marketing (Malu), produto (Rui) ou disciplina direta. Ex.: `schedules.example.json`.
- **Conversa contínua na thread**: menção começando com nome de agente ("Sofia, ...") roteia o
  follow-up direto pra especialista (com contexto da frente via board); produto/sem nome → Ana.
- **Revisora (Vera)**: valida entregáveis de marketing contra os playbooks antes da aprovação
  humana (inline no portão, sem worker). `MARKETING_REVIEW=off` desativa.
- **Briefing interativo**: `ask_clarification` (Malu + especialistas) pergunta na thread e PAUSA
  até a resposta (mencionar o bot na thread responde; registro em `approvals/questions.ts`).
- **Qualidade**: 60 testes (Node test runner), CI no GitHub Actions, harness de eval (scaffold).
- Docs: `PESQUISA-ARQUITETURA.md`, `ARQUITETURA.md`, `DECISAO-LINGUAGEM.md`.

## Como rodar (resumo)
```bash
npm install
npm run backoffice    # http://localhost:4000 — preencher chaves; ver status de prontidão
npm run try:pm -- "descrição completa do bug"   # PM cria ticket no Linear
npm run try:dev -- "tarefa"                      # Dev no sandbox (local) abre PR
npm run dev                                       # time completo no Slack + painel :3000
npm run demo:board                                # kanban demo (sem chaves) em :3000
npm test                                          # 60 testes
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
- Endpoints do Manus/Jira a validar contra a doc oficial; conector Notion a validar com um
  workspace real (integração interna + compartilhamento do database/página).

## ⚠️ Importante para a próxima sessão
- **O contêiner é efêmero**: o que não está no GitHub se perde. Sempre `commit` + `push` ao terminar.
- O push do contêiner exige um **PAT** (Contents+Workflows: write); ou faça o push da sua máquina.

## Como retomar
Numa nova sessão, diga ao Claude algo como:
> "Continuando o projeto movvai-agents (dream team de agentes). Leia `docs/HANDOFF.md` e `docs/ARQUITETURA.md`. Quero [próximo passo]."

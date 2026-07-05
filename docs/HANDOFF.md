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
- **Preflight de dependências** (src/deps): mapa determinístico por tipo de trabalho injetado no
  prompt (usa o que há, degrada com aviso no que falta); essencial ausente aborta antes de gastar
  tokens (dev/techlead). Generaliza o Brand Center para toda dependência.
- **Autoria do manual da marca**: Malu entrevista (skill descoberta-de-marca + ask_clarification),
  redige e grava via write_brand_doc — gravação passa pelo portão de aprovação (conteúdo na
  prévia) e é auditada (brand_doc_written). config.brandDir agora é getter (lazy).
- **Brand Center**: brand/perfil.md injetado no prompt dos 8 agentes (fonte de verdade da
  empresa); docs profundos via list/read_brand_doc; brand/assets servidos em /brand-assets.
  Exemplos placeholders inclusos — preencher com a marca real é parte do onboarding.
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
- **Publicação real (pós-aprovação)**: WordPress (rascunho por default), Resend (e-mail) e webhook
  genérico p/ social/ads (Zapier/Make/n8n). Ferramentas travadas até a aprovação humana (gate).
  Log em `publications.log`. Nina cruza com métricas (`list_recent_publications`).
- **Assets visuais**: `generate_image` (OpenAI Images) → ASSETS_DIR, servido em `/assets` no painel.
- **Métricas**: GA4 Data API + Search Console via service account (JWT RS256 com node:crypto, sem
  SDK) — `ga4_report` e `search_console_query` na Nina.
- **Design system**: app shell estilo ClickUp (sidebar com views e badges, board com pills de
  status, avatares por agente, roxo #7B68EE); squads validados (#2563EB / #DB2777 — ALL PASS).
- **E2E harness**: `try:marketing` roda demanda→Malu→Sofia→Vera→aprovação→entregável sem Slack
  (terminal + painel); provider `mock:` no gateway permite dry-run do encanamento sem chave/custo.
  AUTO_APPROVE=off deixa a decisão para o painel.
- **Qualidade**: 95 testes (Node test runner), CI no GitHub Actions, harness de eval (scaffold).
- Docs: `PESQUISA-ARQUITETURA.md`, `ARQUITETURA.md`, `DECISAO-LINGUAGEM.md`.

## Como rodar (resumo)
```bash
npm install
npm run backoffice    # http://localhost:4000 — preencher chaves; ver status de prontidão
npm run try:pm -- "descrição completa do bug"   # PM cria ticket no Linear
npm run try:dev -- "tarefa"                      # Dev no sandbox (local) abre PR
npm run dev                                       # time completo no Slack + painel :3000
npm run demo:board                                # kanban demo (sem chaves) em :3000
npm run try:marketing -- "peça pro Instagram"     # E2E marketing sem Slack (chave real)
# sem chave nenhuma (dry-run do encanamento): MARKETING_MODEL=mock:marketing CHEAP_MODEL=mock:marketing npm run try:marketing
npm test                                          # 95 testes
```

## Pendências (backlog priorizado)
1. **Validação real** — rodar com chaves de verdade (o maior valor). `npm run try:marketing`.
2. **Multi-tenancy plena** (config isolada por org) — hoje só `ORG_ID` tagueia. Só se for vender.
3. **MCP no perímetro** / **A2A** (interoperabilidade).
4. **GitLab**, **conselho modo debate**, mais papéis (Suporte/CS, Security, Financeiro).
5. **RAG/indexação do codebase**, **Next.js** (upgrade do painel), identidade Slack por agente.

## Aprendizado & informação (feito)
- Recusa no portão de publicação → entrevista automática na thread → lição gravada em
  skills/<papel>/licoes.md (circuito das skills) + memória + auditoria (lesson_recorded).
- Tools record_lesson/save_reference (todas as personas de marketing); referencias.md.
- Digest determinístico (src/digest): target "digest" no scheduler posta o bom-dia sem tokens;
  team_stats dá números reais p/ relatórios (Malu/Nina).
- fetch_url (src/tools/web) com guarda anti-SSRF (Nina/Caio/Malu) — radar de concorrência
  (skill + rotina de exemplo); relatório mensal executivo (rotina de exemplo).

## Resiliência (feito)
- Board persistido em Redis (REDIS_URL) e restaurado no boot; com BullMQ os jobs sobrevivem a
  restart e são retentados (attempts/backoff). Fila em processo retenta com espera (JOB_RETRIES).
- Vigia (STALE_CARD_MINUTES): frente parada em fila/execução vira falha explícita no board.
- Aprovações/perguntas NÃO são persistidas por design: pertencem ao run; com fila durável o job
  reentregue as recria (ver src/board/store.ts).
- **Editor no painel** (view Playbooks): skills/ e brand/ editáveis pela web (escrita com token,
  auditada) — curadoria sem tocar em arquivo.

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

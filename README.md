# movvai-agents — Dream Team Autônomo

Um time autônomo de agentes de IA com quem você **conversa em linguagem natural** no Slack e que
trabalham nas mesmas ferramentas que humanos (Linear, GitHub). Você comanda falando; eles entendem,
investigam, organizam e executam — com **aprovação sua nos pontos-chave**.

Arquitetura **agnóstica de provedor** (Claude, OpenAI, Gemini, open-source) e desenhada para escalar
com custo baixo. Veja o racional completo em [`docs/PESQUISA-ARQUITETURA.md`](./docs/PESQUISA-ARQUITETURA.md)
e o desenho em [`docs/ARQUITETURA.md`](./docs/ARQUITETURA.md).

## Status: Fases 0 → 3

Time autônomo de **cinco agentes** (PM → Tech Lead → Dev → QA → Delivery), roteamento de custo,
memória de longo prazo e aprovação humana nos pontos-chave:

```
Você (Slack) ─"bug no reset de senha"─▶ Ana (PM)
                                          │ investiga + cria ticket (Linear) + consulta memória
                                          │ delega ──(fila)──▶ Rui (Tech Lead)   [se for arquitetural]
                                          │                       │ desenha abordagem + comenta ticket
                                          ▼                       ▼ delega ──▶ Téo (Dev) ── sandbox E2B
                                   responde na thread                            │ implementa + testa
                                            "abro o PR? ✅/❌" ─▶ [aprova] ─▶ commit+PR no HOST
                                                                    │ (token nunca entra no sandbox)
                                                          (fila) ──▶ Bia (QA) ── testa + comenta no PR
                                                                    │
                                                          (fila) ──▶ Dani (Delivery) ── resumo da entrega
```

**Por fase:**
- **Fase 2:** roteamento de custo (tarefa simples → modelo barato), orçamento de tokens, **fila
  plugável** (em processo por padrão; BullMQ/Redis se `REDIS_URL`).
- **Fase 3:** agentes **Tech Lead** e **Delivery Manager**; **memória de longo prazo** (pgvector,
  se `DATABASE_URL`).
- **Fase 3.x:** **hardening completo** — o **token NUNCA entra no sandbox** (nem leitura nem escrita):
  o host baixa o repo via tarball da GitHub API e injeta no sandbox, e o commit/PR são feitos no host
  via Git Data API. Egress controlado por `allowInternetAccess` (allowlist por domínio = template E2B).
  - _Pendente:_ MCP no perímetro (envolver as ferramentas como MCP servers).
- **Conselho multi-modelo** (`deliberate`): em decisões de alto valor (veredito de QA, arquitetura do
  Tech Lead), vários modelos dão parecer em paralelo e um sintetiza — "modelos conversando entre si".
  Liga só com `COUNCIL_MODELS` (≥2 modelos); use com parcimônia (multi-modelo custa mais tokens).
- **Custo & observabilidade:** prompt caching (system+tools reusados, ~90% mais barato na leitura) +
  log de `cacheHitRate`/custo por execução; tracing **OpenTelemetry → Langfuse** (ou qualquer OTLP),
  agnóstico, ligado por `LANGFUSE_*` ou `OTEL_EXPORTER_OTLP_ENDPOINT`.
- **Provedores:** Anthropic, OpenAI, Google e **Ollama** (modelos locais — `ollama:modelo`) via o
  gateway; **Manus** integrado como **agente externo** (tarefa assíncrona), não como modelo de chat.
- **Painel web** (`http://localhost:3000`, `DASHBOARD_PORT`): vê a atividade do time (custo/cache por
  execução) e as **aprovações pendentes** — você pode **aprovar/recusar fora do Slack**. Mesma fonte de
  verdade dos botões do Slack (registro central), então aprovar em qualquer lugar destrava o agente.
- **Kanban da atuação dos agentes** (no topo do painel): um card por frente de trabalho andando por
  **Fila → Em atuação → Aguardando humano → Concluído**, com squad (produto/marketing), última
  nota de progresso e desfecho (ok/falha/recusado). Instrumentado nos handoffs reais (menção,
  delegações, workers e portão de aprovação). Demo sem custo/chaves: `npm run demo:board`.
  - **Interativo:** aprovar/recusar e **responder perguntas direto no card** (a aprovação certa é
    casada por thread+agente), filtro por squad e busca por título/agente.
  - **Dossiê:** clicar no card abre a frente completa — timeline de todas as notas (links
    clicáveis), status, timestamps e as decisões pendentes dela.
- **Rotinas agendadas (cron):** o time trabalha proativamente — relatório de SEO toda segunda,
  calendário social toda sexta. Defina em `schedules.json` (veja `schedules.example.json`; relido
  a cada tick, sem redeploy): `{ name, cron, target, instructions }` com target `marketing`,
  `produto` ou uma disciplina (`conteudo|social|ads|seo`).
- **Conversa contínua na thread:** mencione o bot começando pelo nome do agente ("**Sofia**, troca
  o tom do post 2") e o follow-up vai DIRETO para a especialista certa, com o contexto da frente
  existente. Nomes do time de produto (e mensagens sem nome) seguem para a Ana, que re-delega.
- **Revisão entre agentes (Vera):** antes de pedir SUA aprovação, o entregável de marketing passa
  pela **Vera (revisora)**, que o valida contra os playbooks (skills) da disciplina — menos recusa
  humana. Se ela pedir ajustes, a especialista corrige e tenta de novo. Desative com
  `MARKETING_REVIEW=off`.
- **Briefing interativo:** faltou informação essencial (público? prazo? orçamento?), a Malu e as
  especialistas **perguntam na thread e pausam** (`ask_clarification`, mesma interrupção durável da
  aprovação). Responda mencionando o bot na thread e o trabalho continua.
- **Publicação REAL (pós-aprovação):** aprovado ≠ parado no Notion — o Caio publica no **blog
  (WordPress, rascunho por padrão)** e envia **e-mail (Resend)**; Sofia e Leo despacham posts e
  campanhas via **webhook de automação** (Zapier/Make/n8n → qualquer rede). As ferramentas de
  publicação ficam **travadas até o humano aprovar**. Tudo vira linha no `publications.log`.
- **Assets visuais:** `generate_image` (OpenAI Images, exige `OPENAI_API_KEY`) gera o rascunho do
  criativo; o arquivo fica em `ASSETS_DIR` e é servido pelo painel em `/assets/...` — a URL segue
  junto do post para a automação.
- **Métricas pós-campanha:** a Nina lê números REAIS do **GA4** (`ga4_report`) e do **Search
  Console** (`search_console_query`) via service account, e cruza com `list_recent_publications`
  — fecha o loop *plan → execute → measure* (o relatório semanal via cron usa dados de verdade).
- **Design system:** app shell estilo **ClickUp** — sidebar de navegação com ícones coloridos e
  badges (Board · Aprovações · Perguntas · Atividade · Custo · Auditoria), breadcrumb, board com
  **pill de status por coluna**, cards com **avatar por agente**, roxo `#7B68EE` nas ações; tags
  de squad **validadas** para daltonismo/contraste (produto `#2563EB`, marketing `#DB2777`).
- **Webhooks de entrada** (`POST /webhooks/github`, `/webhooks/linear`): labelar uma issue com `agent`
  (ou o `AGENT_TRIGGER_LABEL`) **dispara o time automaticamente** — sem precisar de menção no Slack.
  Assinatura HMAC verificada; o trabalho é reportado no `SLACK_DEFAULT_CHANNEL`.
- **Controle de acesso (RBAC) + auditoria:** allowlist de aprovadores no Slack (`APPROVER_SLACK_IDS`),
  token para aprovar pelo painel (`DASHBOARD_TOKEN`), e **log de auditoria** append-only (JSONL, pronto
  p/ SIEM) registrando quem aprovou, PRs abertos e tickets criados — tagueado por `ORG_ID`.
- **Billing por consumo:** mede custo/tokens de cada execução (agentes + conselho) **por organização**,
  persiste em JSONL (`BILLING_LOG_PATH`) e mostra os totais no painel (`/api/billing`). Base para cobrança.
- **O time que APRENDE:** cada recusa sua dispara uma entrevista automática ("o que devo
  ajustar?") e a resposta vira **lição permanente** em `skills/<papel>/licoes.md` — entra no
  circuito das skills e é considerada nas próximas execuções. Agentes também consolidam sozinhos
  (`record_lesson` para A/B medido, `save_reference` para material elogiado). Cada "não" melhora
  o time para sempre.
- **O time que INFORMA:** rotina `"target": "digest"` posta o **bom-dia do time** (concluídas,
  em andamento, esperando você, custo, publicações) — 100% determinístico, zero tokens. **Radar
  de concorrência**: Nina lê páginas públicas com `fetch_url` (guarda anti-SSRF) e reporta só o
  que mudou. **Relatório mensal executivo**: Malu compila com `team_stats` (números reais).
- **Resiliência:** com `REDIS_URL`, o **board é persistido e restaurado no boot** e os jobs
  (BullMQ) sobrevivem a restart com **retry/backoff**; sem Redis, a fila em processo retenta
  erros transientes (`JOB_RETRIES`). Um **vigia** marca como falha frentes paradas além de
  `STALE_CARD_MINUTES` — nada gira órfão no board.
- **Editor no painel (view Playbooks):** skills e manual da marca editáveis pela web — quem não
  é técnico cura o comportamento do time; escrita protegida pelo token do painel e auditada.
- **Preflight de dependências (todo trabalho, não só marca):** antes de o agente começar, o worker
  verifica deterministicamente as dependências DAQUELE tipo de trabalho — conhecimento (brand,
  skills), integrações (Notion, WordPress, webhook, GA4, GitHub, sandbox) — e entrega o **mapa no
  prompt** com instrução de degradação para cada ausência. Dependência **essencial** ausente (ex.:
  Dev sem `GITHUB_TOKEN`) **aborta antes de gastar tokens**, com aviso claro na thread. Insumo da
  tarefa (público? prazo?) continua com o briefing interativo (`ask_clarification`).
- **Criação do manual da marca PELO time:** peça *"Malu, precisamos criar o manual da marca"* —
  ela conduz a **entrevista de descoberta** na thread (playbook próprio, uma pergunta por vez),
  redige perfil/brand book/personas/produto e **grava com sua aprovação** (`write_brand_doc`
  mostra o conteúdo completo antes; escrever no Brand Center governa todos os agentes = portão).
  Gravou, o time inteiro já usa (leitura ao vivo).
- **Brand Center (contexto da empresa em TODO fluxo):** `brand/perfil.md` (quem somos, produto,
  tom, público) é **injetado no prompt de todos os agentes** — ninguém trabalha sem saber quem é a
  marca. Documentos profundos (`brand/brand-book.md`, `personas.md`, `produto.md`...) são carregados
  **sob demanda** (`list_brand_docs`/`read_brand_doc`), e os **arquivos da marca** (logo, templates)
  em `brand/assets/` ganham URL via painel (`/brand-assets/...`) para criativos e automações.
  Tudo Markdown editável sem redeploy; exemplos inclusos (⚠️ placeholders — preencha com a sua marca).
- **Skills (playbooks curados):** conhecimento procedural em Markdown que os agentes carregam **sob
  demanda** — `skills/shared/*.md` (todos) e `skills/<papel>/*.md` (só aquele papel, ex.:
  `skills/mkt-social/`). O agente vê o índice (`list_skills`) e carrega só o relevante
  (`load_skill`); o arquivo é lido do disco a cada chamada, então **editar o playbook muda o
  comportamento sem redeploy**. Complementa a memória de longo prazo: memória é o que os agentes
  aprendem; skills são o que você cura. Exemplos inclusos (tom de voz, formatos por canal,
  estrutura de artigo, playbook de lançamento) — edite-os com o conteúdo da sua marca.
- **Squad de MARKETING** (ao lado do time de produto): a Ana reconhece demandas de marketing e delega à
  **Malu (Head de Marketing)**, que cria o **brief no Notion** e aciona as especialistas por frente —
  **Caio** (conteúdo/blog/copy), **Sofia** (social media), **Leo** (campanhas/ads) e **Nina** (SEO/analytics).
  Os entregáveis nascem no Notion (subpáginas do brief) e passam pelo **mesmo portão de aprovação humana**
  antes de serem dados como publicáveis. Liga com `NOTION_API_KEY` + (`NOTION_DATABASE_ID` ou
  `NOTION_PARENT_PAGE_ID`); modelo do squad em `MARKETING_MODEL`.

## Como funciona (estrutura)

```
src/
├── index.ts              # entrypoint: liga Slack → agente PM
├── config.ts             # config tipada via .env
├── models/gateway.ts     # gateway agnóstico de provedor (anthropic|openai|google|gateway)
├── agents/               # personas: types, context, pm, dev, qa
├── agent-runtime/run.ts  # loop de tool-calling + orçamento de tokens
├── models/
│   ├── gateway.ts        # gateway agnóstico de provedor
│   └── router.ts         # roteamento de custo (barato p/ tarefa simples)
├── queue/                # fila de jobs plugável (in-process | BullMQ/Redis)
├── approvals/gate.ts     # aprovação (Slack botões | terminal) com espera durável
├── sandbox/              # e2b (sandbox efêmero) + repo (helpers) — token nunca entra
├── git/                  # fetch (tarball→sandbox) + committer (commit/PR no host)
├── workers/              # techlead, dev, qa, delivery, marketing(-lead) (reagem aos jobs)
├── tools/                # github(-write), linear, notion, delegate, dev-tools, qa-tools, memory, skills
├── connectors/slack.ts   # bot do Slack (Socket Mode): menções + aprovações
├── scripts/              # try-pm e try-dev (smoke tests por terminal)
├── memory/               # thread-memory (curto prazo) + long-term (pgvector)
└── observability/logger.ts # custo/tokens por execução
```

O modelo de cada papel é configurável (`PM_MODEL=provedor:modelo`). Para centralizar
roteamento/caching/custo, aponte `MODEL_GATEWAY_BASE_URL` para um LiteLLM self-hosted.

## Setup

1. **Node 22+** e dependências:
   ```bash
   npm install
   cp .env.example .env   # e preencha as chaves
   ```

2. **Modelo:** preencha pelo menos uma chave de provedor (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
   ou `GOOGLE_GENERATIVE_AI_API_KEY`) compatível com `PM_MODEL`.

3. **Slack App** (Socket Mode):
   - Crie um app em api.slack.com/apps → ative **Socket Mode** (gera `SLACK_APP_TOKEN`, `xapp-...`).
   - Em **OAuth & Permissions**, adicione os scopes de bot: `app_mentions:read`, `chat:write`,
     `reactions:write`. Instale no workspace → copie o `SLACK_BOT_TOKEN` (`xoxb-...`).
   - Em **Event Subscriptions**, inscreva o evento `app_mention`.
   - Copie o `SLACK_SIGNING_SECRET` em Basic Information.

4. **Linear:** gere um `LINEAR_API_KEY` (Settings → API). Opcional: `LINEAR_TEAM_KEY`.

5. **GitHub:** fine-grained PAT em `GITHUB_TOKEN` + `GITHUB_DEFAULT_REPO=owner/repo`.
   - Fase 0 (PM lê): `Contents:read` + `Metadata:read`.
   - Fase 1 (Dev abre PR): `Contents:read+write` + `Pull requests:read+write`.

6. **E2B:** crie uma conta em e2b.dev e coloque a chave em `E2B_API_KEY` (sandbox do Dev).

7. **Notion (squad de marketing):** crie uma integração interna em notion.so/my-integrations
   (`NOTION_API_KEY`), compartilhe com ela o database (`NOTION_DATABASE_ID`) **ou** a página-mãe
   (`NOTION_PARENT_PAGE_ID`) onde os briefs devem nascer.

## Backoffice (configurar tudo pela web)

Em vez de editar o `.env` na mão:
```bash
npm install
npm run backoffice    # abra http://localhost:4000
```
Configura **tudo** num formulário: modelos por papel, chaves de provedor, sandbox, Linear/Jira,
GitHub, Slack, webhooks, RBAC, billing, infra e observabilidade. Mostra o **status de prontidão**
(PM/Dev/Slack/Conselho/Observabilidade) e grava no `.env` local (✓ = definido; segredos não são
exibidos; campos em branco não apagam o que existe). (`npm run setup` é o mesmo comando.)

## Rodar

```bash
npm run dev      # com reload
npm run try:marketing -- "peça de lançamento no Instagram"   # E2E do squad de marketing sem Slack
npm start        # uma vez
npm run typecheck
npm test         # testes unitários (Node test runner + tsx) — sem custo, roda no CI
npm run eval     # harness de eval do conselho (precisa de COUNCIL_MODELS; gasta tokens)
```

**Qualidade:** testes unitários da lógica determinística (router, fila, parsing de diff, custo,
util) rodam no **CI** (`.github/workflows/ci.yml`: typecheck + test a cada push, sem segredos). O
`npm run eval` é um scaffold de avaliação dos agentes (golden set), rodado sob demanda.

Depois, no Slack, em um canal onde o bot esteja: `@Ana tem um bug — usuários não conseguem resetar a senha`.

## Próximas fases

- ✅ **Fase 0:** PM conversacional (Slack → investiga GitHub → ticket no Linear).
- ✅ **Fase 1:** delegação PM → Dev (sandbox E2B, implementa, **pede aprovação** antes de abrir PR).
- ✅ **Fase 2:** roteamento de custo + orçamento de tokens + agente **QA** + fila plugável (BullMQ/Redis).
- ✅ **Fase 3:** **Tech Lead** + **Delivery Manager**, memória de longo prazo (pgvector), commit/PR no
  host (token fora do sandbox).
- **Fase 3.x / 4:** MCP no perímetro + git proxy (token fora do clone), egress allowlist no sandbox,
  Manus/Ollama, A2A, painel web + billing por consumo.

Roadmap completo em [`docs/ARQUITETURA.md`](./docs/ARQUITETURA.md).

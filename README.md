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
  **Fila → Em atuação → Aguardando aprovação → Concluído**, com squad (produto/marketing), última
  nota de progresso e desfecho (ok/falha/recusado). Instrumentado nos handoffs reais (menção,
  delegações, workers e portão de aprovação). Demo sem custo/chaves: `npm run demo:board`.
- **Webhooks de entrada** (`POST /webhooks/github`, `/webhooks/linear`): labelar uma issue com `agent`
  (ou o `AGENT_TRIGGER_LABEL`) **dispara o time automaticamente** — sem precisar de menção no Slack.
  Assinatura HMAC verificada; o trabalho é reportado no `SLACK_DEFAULT_CHANNEL`.
- **Controle de acesso (RBAC) + auditoria:** allowlist de aprovadores no Slack (`APPROVER_SLACK_IDS`),
  token para aprovar pelo painel (`DASHBOARD_TOKEN`), e **log de auditoria** append-only (JSONL, pronto
  p/ SIEM) registrando quem aprovou, PRs abertos e tickets criados — tagueado por `ORG_ID`.
- **Billing por consumo:** mede custo/tokens de cada execução (agentes + conselho) **por organização**,
  persiste em JSONL (`BILLING_LOG_PATH`) e mostra os totais no painel (`/api/billing`). Base para cobrança.
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
├── tools/                # github(-write), linear, notion, delegate, dev-tools, qa-tools, memory
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

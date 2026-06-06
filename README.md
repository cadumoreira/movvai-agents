# movvai-agents — Dream Team Autônomo

Um time autônomo de agentes de IA com quem você **conversa em linguagem natural** no Slack e que
trabalham nas mesmas ferramentas que humanos (Linear, GitHub). Você comanda falando; eles entendem,
investigam, organizam e executam — com **aprovação sua nos pontos-chave**.

Arquitetura **agnóstica de provedor** (Claude, OpenAI, Gemini, open-source) e desenhada para escalar
com custo baixo. Veja o racional completo em [`docs/PESQUISA-ARQUITETURA.md`](./docs/PESQUISA-ARQUITETURA.md)
e o desenho em [`docs/ARQUITETURA.md`](./docs/ARQUITETURA.md).

## Status: Fases 0 → 2

Time conversacional com **três agentes**, roteamento de custo e aprovação humana nos pontos-chave:

> Você menciona `@Ana` (PM) no Slack com um bug → ela investiga (GitHub) e **cria o ticket** (Linear)
> → **delega ao Téo (Dev)** → o Téo sobe um **sandbox E2B**, implementa, roda os testes e **pede sua
> aprovação** antes de **abrir o PR** → a **Bia (QA)** revisa o PR (roda os testes + comenta).

```
Você (Slack) ─"bug no reset de senha"─▶ @Ana (PM)
                                          │ investiga + cria ticket (Linear)
                                          │ delega ──(fila)──▶ Téo (Dev)  ── sandbox E2B
                                          ▼                       │ implementa + testa
                                   responde na thread             ▼
                                            "abro o PR? ✅/❌" ─▶ [aprova] ─▶ abre PR
                                                                    │
                                                          (fila) ──▶ Bia (QA) ── revisa + comenta no PR
```

**Fase 2 também traz:** roteamento de custo (tarefa simples → modelo barato), orçamento de tokens
por execução, e **fila plugável** (em processo por padrão; BullMQ/Redis se `REDIS_URL` existir).

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
├── sandbox/e2b.ts        # sandbox E2B efêmero + clone do repo
├── workers/              # dev-worker e qa-worker (reagem aos jobs)
├── tools/                # github(-write), linear, delegate, dev-tools, qa-tools
├── connectors/slack.ts   # bot do Slack (Socket Mode): menções + aprovações
├── scripts/              # try-pm e try-dev (smoke tests por terminal)
├── memory/thread-memory.ts # memória da conversa por thread
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

## Rodar

```bash
npm run dev     # com reload
npm start       # uma vez
npm run typecheck
```

Depois, no Slack, em um canal onde o bot esteja: `@Ana tem um bug — usuários não conseguem resetar a senha`.

## Próximas fases

- ✅ **Fase 0:** PM conversacional (Slack → investiga GitHub → ticket no Linear).
- ✅ **Fase 1:** delegação PM → Dev (sandbox E2B, implementa, **pede aprovação** antes de abrir PR).
- ✅ **Fase 2:** roteamento de custo + orçamento de tokens + agente **QA** + fila plugável (BullMQ/Redis).
- **Fase 3+:** Tech Lead, Delivery Manager, memória de longo prazo (pgvector), MCP no perímetro,
  credential proxy + egress allowlist, Manus/Ollama, A2A.

Roadmap completo em [`docs/ARQUITETURA.md`](./docs/ARQUITETURA.md).

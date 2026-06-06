# movvai-agents — Dream Team Autônomo

Um time autônomo de agentes de IA com quem você **conversa em linguagem natural** no Slack e que
trabalham nas mesmas ferramentas que humanos (Linear, GitHub). Você comanda falando; eles entendem,
investigam, organizam e executam — com **aprovação sua nos pontos-chave**.

Arquitetura **agnóstica de provedor** (Claude, OpenAI, Gemini, open-source) e desenhada para escalar
com custo baixo. Veja o racional completo em [`docs/PESQUISA-ARQUITETURA.md`](./docs/PESQUISA-ARQUITETURA.md)
e o desenho em [`docs/ARQUITETURA.md`](./docs/ARQUITETURA.md).

## Status: Fase 0

Primeiro agente conversacional ponta-a-ponta — a **PM (Ana)**:

> Você menciona `@Ana` no Slack com um bug/ideia → ela investiga o repositório (GitHub),
> conversa com você e **cria um ticket refinado no Linear**.

```
Você (Slack) ──"tem um bug no reset de senha"──▶ @Ana (PM)
                                                   │ investiga via GitHub (read)
                                                   │ checa duplicados no Linear
                                                   ▼
                                          cria ticket no Linear ──▶ responde no Slack c/ o link
```

## Como funciona (estrutura)

```
src/
├── index.ts              # entrypoint: liga Slack → agente PM
├── config.ts             # config tipada via .env
├── models/gateway.ts     # gateway agnóstico de provedor (anthropic|openai|google|gateway)
├── agents/
│   ├── types.ts          # forma de um agente (persona, modelo, tools, autonomia)
│   └── pm.ts             # a persona da PM (system prompt + ferramentas)
├── agent-runtime/run.ts  # loop de tool-calling (Vercel AI SDK)
├── tools/
│   ├── github.ts         # ferramentas de leitura do GitHub
│   └── linear.ts         # criar/buscar tickets no Linear
├── connectors/slack.ts   # bot do Slack (Socket Mode) que escuta menções
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

5. **GitHub:** fine-grained PAT com `Contents:read` + `Metadata:read` em `GITHUB_TOKEN`, e
   `GITHUB_DEFAULT_REPO=owner/repo`. (Sem isso, a Ana ainda cria tickets — só não investiga o código.)

## Rodar

```bash
npm run dev     # com reload
npm start       # uma vez
npm run typecheck
```

Depois, no Slack, em um canal onde o bot esteja: `@Ana tem um bug — usuários não conseguem resetar a senha`.

## Próximas fases

- **Fase 1:** delegação para o agente **Dev** (sandbox efêmero, implementa, **pede aprovação** antes de abrir PR).
- **Fase 2:** multi-provedor + roteamento por custo (RouteLLM) + agente **QA**.
- **Fase 3+:** Tech Lead, Delivery Manager, memória de longo prazo, MCP no perímetro, Manus/Ollama, A2A.

Roadmap completo em [`docs/ARQUITETURA.md`](./docs/ARQUITETURA.md).

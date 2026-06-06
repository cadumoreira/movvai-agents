# ADR 001 — Escolha de linguagem

> Decisão de arquitetura sobre a linguagem do produto, baseada em pesquisa de mercado
> (jun/2026). Complementa [`PESQUISA-ARQUITETURA.md`](./PESQUISA-ARQUITETURA.md) e
> [`ARQUITETURA.md`](./ARQUITETURA.md).

## Contexto

A plataforma é um time autônomo de agentes que conversa no Slack e trabalha em Linear/GitHub —
um sistema **I/O-bound** (passa o tempo esperando APIs de LLM e de ferramentas), **multi-provedor**,
e **agente-centrado** (cada agente reage a eventos). A pergunta: TS/Node é a melhor linguagem, ou
outra (Python, Go, Rust, Elixir, Java) seria melhor?

## Achado central

**O gargalo é latência de rede de LLM/ferramentas, não CPU nem GIL.** Logo, a "performance da
linguagem" quase não importa para o núcleo. O que decide é: **maturidade de SDKs/ecossistema,
modelo de concorrência I/O, deploy, tipagem e velocidade de dev.**

E o padrão real do mercado (2025/2026) **não é escolher uma linguagem — é poliglota por camada:**

```
Produto / Orquestração   → TypeScript  ou  Python
Infra durável / sandbox  → Go            (E2B, Daytona, Temporal server, Inngest engine, Zoekt)
Isolamento / perf / core → Rust          (Firecracker, Temporal sdk-core, Restate engine, Cursor "Anyrun")
```

Exemplos canônicos: **Cursor** (monolito TS + Rust "Anyrun" + Firecracker), **E2B** (SDK Py/TS +
infra Go + Firecracker Rust), **Temporal** (server Go + core Rust + wrappers poliglotas).

## Comparação resumida

| Linguagem | Para o NÚCLEO de orquestração | Veredito |
|---|---|---|
| **TypeScript/Node** | SDKs de ferramentas TS-nativos (Octokit, `@linear/sdk`, Bolt); serverless/edge maduro (Cloudflare Agents/Durable Objects); produtos de produção em TS (Cursor, Claude Code); TS virou linguagem #1 do GitHub. | ✅ **Escolhida** |
| **Python** | Frameworks de agente mais maduros (LangGraph, CrewAI, AutoGen) e domínio em ML/eval. Empate em SDKs de provedor. Linear **não tem SDK Python oficial**. | Forte alternativa; melhor se for reusar frameworks ou fazer ML pesado |
| **Go** | Concorrência ótima e binário único — **mas para infra** (gateway/sandbox), não para lógica de agente. Ecossistema de framework de agente fraco. | Consumimos via E2B/Daytona (já são Go por baixo); não escrevemos |
| **Rust** | Imbatível em isolamento/perf — **mas nicho** (sandbox runtime, WASM, cores compartilhados). Frameworks de agente ainda 0.x. | Consumimos via Firecracker (E2B); não escrevemos |
| **Elixir/BEAM** | Único candidato conceitual a núcleo (modelo de ator = modelo de agente, supervisão/concorrência nativas). Preço: ecossistema LLM menor, sem nomes públicos de adoção em escala, contratação difícil. | Não agora; reavaliar só se supervisão/concorrência virar o gargalo dominante |
| **Java/Kotlin** | Spring AI/LangChain4j maduros — escolha por **gravidade enterprise**, não por mérito de IA. | Não (não somos loja JVM) |

## Decisão

1. **Núcleo do produto em TypeScript/Node** (orquestração, conectores, agentes, API, frontend).
   Motivos decisivos para *este* produto: os SDKs das ferramentas que conectamos (Slack/Linear/GitHub)
   são TS-nativos e mais bem tipados; deploy serverless/edge maduro; tipagem end-to-end reduz bugs;
   e é onde os produtos de agente de produção convergiram.

2. **Já somos poliglatas — sem escrever Go/Rust.** A camada de infra (sandbox E2B/Daytona, e
   eventual durabilidade com Temporal) é Go/Rust **por baixo**, mas a consumimos via **SDKs TS**.
   Ganhamos os benefícios sem o custo de manter outra linguagem.

3. **Python como sidecar opcional e tardio** — só se/quando precisarmos de ML/eval/data-processing
   que o ecossistema Python faz melhor, ou de um executor de coding pronto (ex.: OpenHands). Via
   contrato REST/gRPC. **Não** montar poliglota prematuramente (anti-padrão citado na pesquisa).

4. **Durabilidade/supervisão de "atores" sem trocar de linguagem:** se precisarmos de workflows
   duráveis e recuperação de falha no estilo BEAM, usamos **Temporal** (SDK TS) em vez de migrar
   para Elixir.

## Consequências

- Mantemos o código já escrito na Fase 0 (TS) e seguimos nele.
- Aceitamos abrir mão dos frameworks de agente Python-first (LangGraph/CrewAI) — alinhado à
  recomendação da pesquisa de **não adotar frameworks pesados** e construir orquestração própria
  com padrões simples.
- Se um dia o ML/eval próprio crescer, plugamos um serviço Python por contrato — decisão reversível.

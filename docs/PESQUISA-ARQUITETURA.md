# Squads Autônomas de Agentes de IA — Pesquisa de Arquitetura

> Relatório de pesquisa para projetar uma plataforma onde o usuário "aloca" agentes de IA
> que se conectam a repositórios e executam o ciclo de SDLC (PO → Tech Lead → Devs → QA →
> Delivery Manager), com **arquitetura agnóstica de modelo/provedor** (Claude, OpenAI, Gemini,
> Manus, open-source) e foco em **escalar muito com custo baixo**.
>
> **Data:** junho/2026. Baseado em 8 frentes de pesquisa paralelas (~200 fontes: papers
> arXiv/ICLR/NeurIPS, docs oficiais, leaderboards e análise de produtos). Preços e benchmarks
> mudam em escala de semanas — re-validar números antes de decisões de orçamento.

---

## Sumário executivo (TL;DR)

1. **Multi-agente não é bala de prata para escrever código.** A evidência (Anthropic, Cognition,
   papers Agentless/MAST) converge: agentes paralelos brilham em tarefas **read-only / breadth-first**
   (discovery, leitura de repo, busca, QA) e **falham quando precisam escrever artefatos
   interdependentes** (o caso do coding). Codificar é pouco paralelizável.
   → **Desenho híbrido:** multi-agente para os papéis de "leitura/planejamento", pipeline
   determinístico + single-agent com contexto compartilhado para a **escrita de código**.

2. **Confiabilidade real é ~45–55%, não ~80%.** O SWE-bench Verified está contaminado
   (vazamento de solução, memorização). Em benchmarks descontaminados (SWE-bench Pro) os
   melhores modelos caem para ~65–69%. → **Revisão humana obrigatória** (human-in-the-loop)
   entre fases; nunca prometer autonomia confiável fim-a-fim.

3. **Independência de provedor = LiteLLM (self-hosted) + escape hatch nativo.** Formato
   OpenAI como denominador comum, mas com passthrough nativo para o que "vaza" (tool-calling
   paralelo, prompt caching, structured output, extended thinking). Frontend TS com Vercel AI SDK.
   **Manus não é um LLM intercambiável** — é uma API de *tarefas assíncronas*; integra como
   "agente externo / tool", não no slot de chat-completions.

4. **Custo é dominado por tokens, não por sandbox.** Prompt caching (até 90% na leitura) é a
   alavanca #1; o loop de agente cresce **O(N²)** (rebilha o histórico). Roteamento por modelo
   economiza 30–50% realista (não 85%). → Budget enforcement **ativo** no gateway + compaction +
   roteamento por tier.

5. **Padrão de execução: ambiente efêmero por tarefa em microVM (Firecracker/E2B/Daytona),
   GitHub App com tokens de 1h, credential proxy e egress allowlist.** Tratar **todo conteúdo do
   repo como não confiável** (prompt injection via PR/issue já vazou API keys em 3 produtos reais).

6. **MCP é o padrão de facto para ferramentas; A2A para comunicação entre agentes.** Ambos sob a
   Linux Foundation. Adotar MCP já; A2A faseado. Segurança de MCP servers é o calcanhar de Aquiles.

7. **O conceito "membro do time" já existe no mercado** (Devin "managed Devins", CrewAI com papéis
   explícitos). O diferencial defensável da sua plataforma é ser **genuinamente multi-provedor +
   orquestração de papéis de SDLC + custo controlado** — território onde só a Factory.ai está forte.

---

## 1. Panorama do mercado (o que já existe)

### Eixo "multi-modelo vs preso a um modelo"
- **Genuinamente agnósticos:** **Factory.ai** (Droids — roteia entre Claude/GPT/Gemini/DeepSeek/Qwen
  por custo/latência/qualidade; #1 no Terminal-Bench; clientes Nvidia/Adobe/Bayer), **OpenHands**
  (open-source, multi-modelo total, PAYG sem markup), **CrewAI/LangGraph** (frameworks agnósticos),
  GitHub Copilot, Augment, Qodo, Sourcegraph Cody/Amp.
- **Presos/opacos (não expõem o modelo):** **Devin** (família Claude por baixo), **Manus** (Claude),
  Replit, Lovable, Bolt, v0.
- Players grandes (Cursor, Cognition/Windsurf) **construíram modelos próprios** (Composer, SWE-1.5)
  para reduzir dependência e custo de provedores frontier.

### Eixo "time/squad de agentes com papéis" (o conceito que você descreveu)
- **Devin — o mais próximo de "aloque um membro do time":** "managed Devins" em paralelo, cada um
  com VM isolada, coordenados por um Devin principal que faz scoping e resolve conflitos.
- **CrewAI — o framework purista de papéis:** agentes com `role`/`goal`/`backstory`/`tools` + tarefas
  atribuídas. É o modelo mental exato de "time virtual".
- **Cursor:** paralelismo (até 8 agentes via git worktrees), mas **sem papéis nomeados**.
- **Augment/Qodo:** squad implícito por especialidade/modelo (ex.: Coordinator em Sonnet +
  Implementors em Haiku + Opus para arquitetura).

### O que a precificação revela
- O mercado inteiro está **migrando de assinatura plana → consumo**, sinal de que o custo marginal de
  um agente autônomo é alto e variável: Devin **ACU (~$8–9/h ativa)**, GitHub **"AI Credits"** (jun/2026),
  Replit **effort-based** ($0,10 simples a $5+ complexo), Augment/Qodo **créditos**.
- **OpenHands e Sourcegraph Amp cobram PAYG sem markup** → o custo real é dominado por inferência,
  e eles repassam direto.

### Ceticismo (importante)
- Claims de produtividade ("3–4x", "87% same-day", "13x mais rápido") são **de fornecedor**.
  A pesquisa do próprio **Goldman Sachs (mar/2026) não achou ganho macro significativo**; um teste real
  citado teve **Devin resolvendo só 3 de 20 tarefas**.
- Consolidação acelerada: Cognition comprou e aposentou a Windsurf; **Meta comprou a Manus (~$2B)**.

### Maturidade
- Gartner 2026: ~61% de grandes empresas com ≥1 sistema de agentes em produção (vs 18% em 2024).
  O padrão de 2026 é a transição de "pair programming" para "orquestração paralela de squads",
  **ainda com humano no loop de review.**

---

## 2. Evidência de arquitetura (multi-agente vs simples)

**Princípio nº 1 (Anthropic, "Building Effective Agents"):** comece com o mais simples; adicione
sistemas agênticos multi-passo só quando o simples não basta. As melhores implementações **não usavam
frameworks complexos** — usavam padrões simples e componíveis.

**A fronteira onde multi-agente funciona (consenso Anthropic + Cognition):**
- ✅ **Funciona** em tarefas read-only / breadth-first com caminhos independentes: pesquisa, busca em
  código, leitura de docs, análise de cobertura. (Anthropic: orchestrator-worker superou single-agent
  em ~90% no eval de Research — **ao custo de ~15× tokens**.)
- ❌ **Falha** quando subagentes precisam **escrever** artefatos com decisões interdependentes — exatamente
  o caso de coding. Cognition ("Don't Build Multi-Agents"): subagentes em isolamento de contexto produzem
  resultados conflitantes. Anthropic: "a maioria das tarefas de coding tem menos paralelismo real que pesquisa".

**Achados contra-intuitivos dos papers (todos apontam simplicidade > complexidade):**
- **Agentless** (arXiv 2407.01489): pipeline determinístico de 3 fases (localização → reparo → validação)
  **sem** o LLM decidir ações bate os agentes open-source no SWE-bench Lite a **~4× menos custo**.
- **MAST** (Berkeley, arXiv 2503.13657): taxonomia de **14 modos de falha** de MAS; ganhos sobre
  single-agent são "frequentemente mínimos" e as falhas exigem **soluções estruturais, não tweaks de prompt**.
- **MetaGPT** (arXiv 2308.00352): estruturar o workflow como **artefatos padronizados** (PRD, design,
  API) reduz cascata de erro melhor do que adicionar agentes.
- **SWE-agent** (arXiv 2405.15793): o maior ganho vem da **interface agente-ferramenta (ACI)** bem
  desenhada, não da "inteligência" do agente.
- **Estudo de orçamento igualado** (arXiv 2505.18286): com mesmo budget de tokens, single-agent iguala
  ou supera multi-agent; overhead de coordenação consome +58% a +285% de tokens.

**Conclusão de design:** o modelo "empresa de software virtual" (MetaGPT/ChatDev) é o **blueprint
conceitual certo para os papéis**, mas a execução deve ser:
- **Pipeline explícito com gates humanos** (estilo LangGraph plan-then-execute, durable execution,
  `interrupt_before`) — não um enxame conversacional autônomo.
- **Handoffs como artefatos tipados** (PRD → design doc → diff → relatório de teste), não diálogo livre.
- **Multi-agente só nos papéis de leitura/planejamento**; **escrita de código em single-agent/pipeline
  com contexto compartilhado.**

---

## 3. Independência de provedor (requisito-chave)

**Recomendação:** camada de abstração **OpenAI-compatible (LiteLLM self-hosted) + adapters nativos
pontuais** para os recursos que vazam. Evitar gateway gerenciado como única dependência (SPOF + lock-in
no próprio gateway).

| Camada | Escolha | Porquê |
|---|---|---|
| Gateway de modelos (backend) | **LiteLLM self-hosted** | 100+ provedores em formato OpenAI; cost tracking, fallback, virtual keys; sem markup nem SPOF externo. Usado por Netflix/Lemonade. |
| Escape hatch nativo | **Passthrough** (`/v1/messages` p/ Claude) | Tool-calling paralelo, prompt caching, structured output e extended thinking **não sobrevivem** à conversão para o denominador comum. |
| Frontend / SDK TS | **Vercel AI SDK** | Troca de provedor em ~2 linhas; tool-calling/streaming/structured output unificados. |
| Roteamento de custo | **RouteLLM / OpenRouter auto** | Roteia barato↔caro por dificuldade. 30–50% realista. Cuidado: "routing collapse" e misrouting. |
| Modelos locais | **Ollama / vLLM** | Já cobertos nativamente pelo LiteLLM via interface OpenAI-compatible. |

**Diferenças que quebram a abstração (precisam de adapter próprio mesmo com gateway):**
- **Tool-calling:** 3 modelos estruturais distintos (Anthropic content-blocks; OpenAI `tools`/`tool_calls`;
  Gemini estilo protobuf). Tool-calling **paralelo** notoriamente não traduz bem (exige "message sanitization").
- **Structured output:** OpenAI `response_format` (maduro) vs Gemini `response_schema` vs Anthropic
  (beta nov/2025, sem schemas recursivos nem constraints numéricos).
- **Prompt caching:** OpenAI automático ~50% off; Anthropic explícito ~90% off **mas cobra escrita**;
  Gemini cobra storage e exige contexto grande. **A estratégia ótima de prompt difere por provedor.**

**Manus:** API baseada em **tarefas assíncronas** (cria task → `task_id` → webhook/poll → coleta
artefatos). **Não é drop-in com Claude/GPT/Gemini.** Integrar como **"executor de tarefas / agente externo"**
atrás de um adapter próprio, nunca no slot de chat-completions.

---

## 4. Sandbox & segurança (conectar a repositórios)

**Execução:** ambiente **efêmero por tarefa em microVM Firecracker** (gerenciado via **E2B** ou
**Daytona**, ou Firecracker self-hosted). Docker puro (runc) é **insuficiente** para código não confiável
de agente (compartilha kernel do host). gVisor só se precisar de GPU. O que os produtos usam: Devin
(Devbox/VM), OpenHands (Docker hardenizado + runtime gerenciado opcional), **Manus usa E2B**.

**GitHub:**
- **GitHub App** (tokens de instalação de **1h**) é o único caminho production-viable para multi-org.
  Fine-grained PAT para começar.
- Permissões mínimas para branch+push+PR: `Contents: rw`, `Metadata: r`, `Pull requests: w`, **por repo**.
- Disparo por **webhook** em `issues`/`issue_comment` (padrão label/@mention).

**Segurança (não opcional):**
- **Tratar TODO conteúdo do repo como não confiável** (issues, PRs, comentários, código). Prompt injection
  via título de PR já fez 3 produtos reais (Claude/Gemini/Copilot actions) vazarem API keys.
- **Segredos NUNCA no container/env do agente.** Usar **credential proxy** (o agente conhece só a URL do
  proxy; o proxy injeta auth na saída). Referência open-source: Infisical agent-vault.
- **Egress default-deny + allowlist** (github.com, npm, pypi, registries). Assumir que mitigações de
  runtime sozinhas são contornáveis ("living off the land" via APIs do próprio GitHub).
- Logar toda tool-call/destino/decisão; semear **canary secrets** para testar exfiltração.

**Custo de sandbox:** ~$0,05/vCPU-h (E2B/Daytona) → uma tarefa de 20 min em 2 vCPU ≈ **$0,03**. O custo
de **tokens domina** o de sandbox.

---

## 5. Protocolos de interoperabilidade (MCP & A2A)

- **MCP (Model Context Protocol):** padrão de facto para **ferramentas plugáveis**. Governança neutra
  (Agentic AI Foundation / Linux Foundation, dez/2025, co-fundada por Anthropic+Block+OpenAI). Adotado por
  OpenAI, Google, Microsoft. **Adotar já** como camada de ferramentas agnóstica de provedor.
- **A2A (Agent2Agent):** comunicação **entre agentes** de fornecedores diferentes (Agent Cards para
  descoberta). Google → Linux Foundation; v1.0 production-ready; ACP da IBM convergiu para ele. **Planejar
  faseado** ("MCP first, A2A gradually").
- **Segurança de MCP é o calcanhar de Aquiles:** CVEs reais de *tool poisoning* (uma ferramenta segura no
  dia 1 pode virar maliciosa no dia 7), RCE via `mcp-remote`, backdoor em pacote npm. Mitigações:
  gateway MCP no próprio perímetro, OAuth 2.1+PKCE, version-pinning + assinatura de tool definitions,
  `mcp-scan` no CI, human-in-the-loop para ações destrutivas, logs → SIEM. **Tratar todo MCP server de
  terceiros como não confiável.**

---

## 6. Modelos & economia de tokens (jun/2026)

> **output domina o custo** (5–8× o input). Coding gera muito output (diffs, raciocínio) → output + caching
> são as variáveis que mais mexem na conta.

### Preço por 1M tokens (input / output)
| Modelo | Input | Output | Contexto | Observação |
|---|---|---|---|---|
| Claude Opus 4.8 | $5,00 | $25,00 | 1M | cache read $0,50; topo de coding |
| Claude Sonnet 4.6 | $3,00 | $15,00 | 1M | melhor custo-benefício mid (Anthropic) |
| Claude Haiku 4.5 | $1,00 | $5,00 | 200K | papéis baratos/triagem |
| GPT-5.5 | $5,00 | $30,00 | ~400K | Batch/Flex → $2,50/$15 |
| GPT-5 base | $1,25 | $10,00 | ~400K | bom custo-benefício mid |
| Gemini 3 Pro | $2,00 | $12,00 | 1M | **melhor custo×capacidade entre flagships** |
| Gemini 3 Flash | $0,50 | $3,00 | 1M | barato e forte em código |
| DeepSeek V3 | $0,14 | $0,28 | 128K | open-source de altíssimo valor |
| Qwen3 Coder 480B | $0,22 | $1,00 | 256K+ | ~80% SWE-bench a fração do custo |

### Benchmarks de código (cuidado com contaminação — comparar dentro da mesma fonte)
- **SWE-bench Verified:** topo ~88–89% (Opus 4.8 / GPT-5.5), Gemini 3.1 Pro ~80%. **Mas contaminado** →
  usar **SWE-bench Pro** (Opus 4.8 ~69%, Opus 4.7 ~64%) como sinal mais limpo.
- **Aider Polyglot:** Opus 4.5 ~89%, GPT-5 ~88%, DeepSeek V3.2 ~74% (melhor open-source).
- **LiveCodeBench:** Gemini 3 Pro ~92% lidera.
- **Terminal-Bench 2.0:** GPT-5.5 ~82% lidera.

### Alavancas de custo (em ordem de ROI)
1. **Prompt caching** (até 90% leitura/Anthropic, ~50% OpenAI) — system prompt + tools + arquivos do repo
   são prefixos reusados a cada turn. Anthropic é o único que **cobra escrita de cache** (break-even ~2 leituras).
2. **Eficiência de tokens / O(N²)** — loop rebilha histórico; combater com **compaction**. Effort baixo
   (Opus) iguala scores usando ~76% menos output tokens.
3. **Budget enforcement ativo no gateway** (teto por request, budget rolante por sessão, cap por chave,
   circuit breakers) — não monitoramento passivo. Partida: 200k–500k tokens/sessão.
4. **Roteamento por tier** — 30–50% realista. Modelo barato/open-source para tarefas simples (PO, triagem,
   QA leve), frontier para coding difícil.
5. **Batch API (50% off)** — só na periferia assíncrona (indexação de codebase, eval offline, triagem em massa).

### Custo prático por tarefa
- Tarefa de engenharia autônoma ≈ **dezenas a centenas de milhares de tokens** somando os turnos.
- PR moderadamente complexo: **~$1–$10+** (Opus), dependendo de effort, nº de turnos e caching.
- Sessão oficial de 1h em Opus 4.8: **$0,70** (cai a $0,52 com caching).
- **Self-host só compensa** em volume muito alto (100M+ tokens/dia) ou exigência de dados on-prem;
  custos ocultos de DevOps multiplicam 3–5×.

---

## 7. Observabilidade & avaliação

- **Tracing agnóstico:** adotar **OpenLLMetry / OpenTelemetry GenAI** (portabilidade; Langfuse/Phoenix/
  LangSmith ingerem spans OTel → evita lock-in). **Langfuse** (open-core MIT, self-host) é boa base.
- **Rastrear por run:** tokens, custo, latência (P50/P99), error rate, **cache-hit rate**, taxa de sucesso.
- **Avaliação:** para coding, preferir **graders determinísticos (rodar os testes)** sobre LLM-judge.
  Usar **pass^k** (sucesso consistente em k tentativas) e **golden set imutável** + eval set crescente de
  falhas reais; **gate no CI** para falhar build em regressão. Validar com **SWE-bench Pro/rebench**, não
  só Verified.

---

## 8. Recomendação de arquitetura concreta

```
┌──────────────────────────────────────────────────────────────────────────┐
│  FRONTEND (Next.js + Vercel AI SDK)  — alocar squad, acompanhar, aprovar   │
└───────────────┬──────────────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────────────┐
│  ORQUESTRADOR (TypeScript) — máquina de estados explícita (plan-then-       │
│  execute), gates humanos entre fases, handoffs como ARTEFATOS TIPADOS.      │
│  Papéis: PO → Tech Lead → Dev(s) → QA → Delivery Manager.                   │
│  • Papéis de LEITURA/PLANEJAMENTO: podem rodar em paralelo (multi-agente).  │
│  • ESCRITA DE CÓDIGO: single-agent/pipeline c/ contexto compartilhado.      │
└───┬───────────────┬───────────────────┬───────────────────┬───────────────┘
    │               │                   │                   │
┌───▼────┐   ┌──────▼───────┐   ┌───────▼────────┐   ┌──────▼──────────────┐
│ FILA / │   │ GATEWAY DE   │   │ SANDBOX        │   │ FERRAMENTAS (MCP)   │
│ EVENTOS│   │ MODELOS      │   │ (microVM       │   │ git, testes, etc.   │
│(BullMQ │   │ LiteLLM      │   │  efêmera:      │   │ + credential proxy  │
│/Redis  │   │ + passthrough│   │  E2B/Daytona)  │   │ + egress allowlist  │
│ ou     │   │ + RouteLLM   │   │  por tarefa    │   └─────────────────────┘
│Temporal│   │ (Claude/GPT/ │   └────────────────┘
│)       │   │ Gemini/Manus*│
└────────┘   │ /Ollama)     │   * Manus via adapter de tarefa assíncrona
             └──────┬───────┘
                    │
        ┌───────────▼───────────┐   ┌──────────────────────────────┐
        │ ESTADO / MEMÓRIA       │   │ OBSERVABILIDADE              │
        │ Postgres (state) +     │   │ OpenLLMetry → Langfuse       │
        │ pgvector/memória longa │   │ cost/trace/eval no CI        │
        └────────────────────────┘   └──────────────────────────────┘
```

### Stack de referência (TS-first onde faz sentido)
- **Orquestração:** máquina de estados própria em TypeScript ou **LangGraph.js** (durable execution,
  `interrupt_before` para gates humanos). **Temporal** se precisar de durabilidade/retries de nível produção.
- **Fila/eventos:** BullMQ + Redis (simples) ou Temporal (workflows duráveis).
- **Gateway de modelos:** **LiteLLM** (self-hosted) + passthrough nativo + RouteLLM.
- **Sandbox:** **E2B** ou **Daytona** (microVM por tarefa) no MVP; Firecracker self-hosted em escala.
- **Ferramentas:** **MCP** (servidores no próprio perímetro) + credential proxy.
- **Estado/memória:** Postgres + pgvector.
- **Observabilidade:** OpenLLMetry/OTel → Langfuse.
- **Frontend:** Next.js + Vercel AI SDK.

### Como cada papel mapeia para modelo (custo × capacidade)
| Papel | Tipo | Modelo sugerido (default) | Por quê |
|---|---|---|---|
| Product Owner | leitura/planejamento | Sonnet 4.6 / Gemini 3 Flash | refinamento não precisa do topo |
| Tech Lead/Arquiteto | leitura + decisão | Opus 4.8 / Gemini 3 Pro | decisões de arquitetura são pivotais |
| Desenvolvedor | escrita de código | Opus 4.8 / GPT-5.5 | exige o topo de capacidade |
| QA | leitura/análise (paralelizável) | Haiku 4.5 / DeepSeek / Qwen Coder | volume alto, custo baixo |
| Delivery Manager | coordenação/sumarização | Sonnet 4.6 / Haiku 4.5 | tarefa leve |

(Tudo configurável por papel via o gateway; o roteador pode rebaixar para modelo barato em tarefas simples.)

---

## 9. Riscos

| Risco | Mitigação |
|---|---|
| **Overengineering multi-agente** (overhead +58–285% de tokens, fragilidade) | Começar em pipeline; subir para multi-agente só onde a falha for de roteamento, não de qualidade. Multi-agente só em papéis read-only. |
| **Expectativa de autonomia irreal** (~45–55% real) | Human-in-the-loop obrigatório; vender "acelera o time", não "substitui". |
| **Prompt injection / vazamento de segredos** | Credential proxy, egress allowlist, conteúdo do repo como não confiável, canários, sandbox efêmero. |
| **Custo fugindo de controle** (loop O(N²), routing collapse) | Budget enforcement ativo no gateway, compaction, cache-hit como métrica, monitorar decisões de roteamento. |
| **Abstração de provedor vazando** (tool-calling/caching/structured output) | LiteLLM + passthrough nativo + adapters por recurso; testar paridade por provedor. |
| **Lock-in / instabilidade de frameworks** (AutoGen/AG2 split, specs MCP evoluindo rápido) | Camada de abstração própria; não acoplar profundamente a um framework; pinar versões. |
| **Segurança de MCP servers de terceiros** | Gateway MCP no perímetro, version-pinning + assinatura, mcp-scan no CI, tratar como não confiável. |
| **Benchmarks enganosos** (contaminação) | Validar em código privado, SWE-bench Pro/rebench, eval temporal. |

---

## 10. Roadmap de MVP faseado

**Fase 0 — Fundação (1 fluxo, 2 papéis, 1 provedor)**
- Gateway LiteLLM + 1 provedor (Claude), Postgres para estado, sandbox E2B/Daytona.
- Fluxo **PO → Dev** ponta-a-ponta: issue do GitHub → PO refina em spec tipada → Dev implementa em
  sandbox, abre PR. Gate humano antes do Dev e antes do merge.
- Observabilidade desde já (OTel → Langfuse), com custo por run.

**Fase 1 — Multi-provedor + roteamento**
- Adicionar OpenAI e Gemini via LiteLLM; passthrough nativo para caching/tool-calling.
- RouteLLM por tier (barato para PO/QA, frontier para Dev). Prompt caching ligado.
- Budget enforcement no gateway (teto por sessão).

**Fase 2 — Squad completa + QA**
- Adicionar Tech Lead, QA e Delivery Manager. Handoffs como artefatos (PRD → design → diff → testes).
- QA com graders determinísticos (rodar testes) e gate no CI.
- Memória de longo prazo (pgvector) e compaction.

**Fase 3 — Hardening de segurança e escala**
- Credential proxy, egress allowlist, GitHub App (tokens 1h), canários.
- MCP para ferramentas plugáveis (servidores no perímetro + mcp-scan no CI).
- Eval set crescente + golden set; validar com SWE-bench Pro.

**Fase 4 — Interoperabilidade e ecossistema**
- Adapter Manus (tarefa assíncrona) e Ollama/vLLM (modelos locais).
- A2A para comunicação entre agentes (faseado).
- Multi-org via GitHub App; billing por consumo (espelhando o mercado).

---

## Fontes principais (seleção)
- Anthropic — *Building Effective Agents*, *Multi-agent research system*, *Effective context engineering*,
  *Demystifying evals*, pricing oficial.
- Cognition — *Don't Build Multi-Agents*, *Multi-Agents: What's Actually Working*.
- Papers: Agentless (2407.01489), MAST (2503.13657), MetaGPT (2308.00352), SWE-agent (2405.15793),
  OpenHands (2407.16741), AutoGen (2308.08155), FrugalGPT (2305.05176), RouteLLM (2406.18665),
  SWE-bench (2310.06770) e críticas de contaminação (SWE-Bench+ 2410.06992, SWE-bench Pro, 2512.10218).
- Protocolos: modelcontextprotocol.io, Linux Foundation (A2A/AAIF), CVEs MCP (tool poisoning).
- Gateways: LiteLLM, Vercel AI SDK, RouteLLM/RouterArena (2510.00202).
- Sandbox: Northflank, E2B, Daytona, OpenHands docs, GitHub docs (GitHub Apps, fine-grained PAT).
- Leaderboards: swebench.com, Aider Polyglot, LiveCodeBench, Terminal-Bench, Artificial Analysis.

> ⚠️ Vários números de adoção e "% de economia" vêm de blogs/press de fornecedores e devem ser lidos
> como ordem de grandeza. As evidências mais sólidas: posições públicas de Anthropic/Cognition, papers
> revisados, docs oficiais e CVEs. Preços e benchmarks mudam em semanas — re-validar antes de orçar.

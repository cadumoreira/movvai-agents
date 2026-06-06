# Arquitetura — Dream Team Autônomo

> Documento de arquitetura concreto para a visão do produto, construído sobre a pesquisa em
> [`PESQUISA-ARQUITETURA.md`](./PESQUISA-ARQUITETURA.md).
>
> **Visão:** um time autônomo de "colegas de trabalho" de IA com quem você **conversa em linguagem
> natural** nas mesmas ferramentas que humanos usam (Slack), que **leem/escrevem nas mesmas ferramentas
> de trabalho** (Linear, GitHub) e que **delegam tarefas entre si** de forma visível. Você comanda
> falando; eles entendem, investigam, organizam, executam e reportam.
>
> **Exemplo-guia:** você manda no Slack "tem um bug X em produção" → o **agente PM** entende, olha o
> repositório, refina e **abre um ticket no Linear** → **passa a demanda para o agente Dev** (no Slack,
> visível) → o **Dev** pega o ticket, executa no sandbox, abre PR e **reporta de volta**.
>
> **Decisões fechadas:** autonomia com **aprovação em pontos-chave**; conectores iniciais **Slack +
> Linear + GitHub**; arquitetura **agente-centrada e event-driven** (não pipeline).

---

## 1. Mudança de mentalidade: de "pipeline" para "time de plantão"

A diferença central em relação a uma ferramenta de automação tradicional:

| Pipeline (modelo antigo) | Dream Team (este modelo) |
|---|---|
| Um maestro roda os passos do início ao fim | Cada agente é um **serviço persistente** que fica "de plantão" |
| Dispara uma vez, termina | **Reage a eventos** continuamente (mensagem, ticket, comentário) |
| Comunicação interna invisível | Comunicação **visível** nas ferramentas humanas (Slack/Linear) |
| Você configura e espera | Você **conversa** e acompanha como com um colega |

Cada agente (PM, Dev, QA…) é uma **persona persistente** com identidade própria (um bot no Slack, um
usuário no Linear/GitHub), papel, memória e política de autonomia. As **ferramentas humanas são o
barramento de comunicação E o estado compartilhado** do time — não há um "banco de dados secreto" de
coordenação; o ticket no Linear *é* o handoff, a thread no Slack *é* a conversa.

> **Por que isso é arquitetonicamente forte (e não só bonito):** a pesquisa mostrou que sistemas
> multiagente quebram por *isolamento de contexto* e *erros em cascata invisíveis* (taxonomia MAST,
> Berkeley). Ao fazer a comunicação acontecer em canais **observáveis** (Slack/Linear), ganhamos
> transparência e **human-in-the-loop natural** — você vê o handoff e intervém antes de virar bola de
> neve. E usar o ticket como artefato de handoff é exatamente o padrão "estruture o workflow, não só a
> conversa" (MetaGPT) nascendo de graça do design.

---

## 2. Anatomia de um agente

Cada agente é a mesma "forma", parametrizada:

```
Agente
├── Identidade        → bot no Slack + usuário no Linear/GitHub (tem nome, avatar, @menção)
├── Persona/Papel     → system prompt (PM, Tech Lead, Dev, QA, Delivery Manager)
├── Modelo            → configurável por papel (via gateway agnóstico — ver §5)
├── Ferramentas (MCP) → Slack, Linear, GitHub, sandbox, busca — plugáveis por papel
├── Memória           → curto prazo (thread atual) + longo prazo (pgvector: decisões, contexto do projeto)
├── Política de autonomia → o que faz sozinho vs o que pede aprovação (ver §4)
└── Caixa de entrada  → eventos que ele escuta (menção no Slack, ticket atribuído, PR comentado…)
```

**Papéis do MVP e mapeamento de modelo** (custo × capacidade — tudo configurável):

| Agente | Tipo de trabalho | Modelo default | Escuta (eventos) |
|---|---|---|---|
| **PM/PO** | leitura + refino (paralelizável) | Sonnet 4.6 / Gemini 3 Flash | menção no Slack, novo bug reportado |
| **Tech Lead** | leitura + decisão de arquitetura | Opus 4.8 / Gemini 3 Pro | ticket marcado "precisa de design", menção |
| **Dev** | **escrita de código** (single-agent) | Opus 4.8 / GPT-5.5 | ticket atribuído a ele, comentário em PR |
| **QA** | leitura/análise + rodar testes | Haiku 4.5 / DeepSeek / Qwen | PR aberto, ticket em "review" |
| **Delivery Manager** | coordenação/sumarização | Sonnet 4.6 / Haiku 4.5 | mudanças de status, pedido de relatório |

> **Fronteira de design (da pesquisa):** PM/Tech Lead/QA fazem trabalho **read/planejamento** → podem ser
> multi-agente e paralelos. O **Dev escrevendo código** roda como **single-agent com contexto coeso**
> dentro de um sandbox — é onde multi-agente comprovadamente falha (decisões interdependentes).

---

## 3. Arquitetura event-driven

```
   VOCÊ (humano)
      │  "tem um bug X em produção"  (linguagem natural)
      ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  CAMADA DE CONECTORES (webhooks + APIs)                                    │
│  Slack  ·  Linear  ·  GitHub      ← barramento de comunicação + estado     │
└───────────────┬────────────────────────────────────────────────────────── ┘
                │ eventos normalizados (mensagem, ticket.criado, ticket.atribuído,
                │ pr.aberto, pr.comentado, ci.finalizado…)
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  EVENT BUS / FILA  (Redis + BullMQ, ou Temporal para durabilidade)         │
│  roteia cada evento para a "caixa de entrada" do(s) agente(s) certo(s)     │
└───────────────┬────────────────────────────────────────────────────────── ┘
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  RUNTIME DE AGENTES  (cada agente = um worker que reage a eventos)         │
│                                                                            │
│   ┌─ PM ─┐   ┌─ Tech Lead ─┐   ┌─ Dev ─┐   ┌─ QA ─┐   ┌─ Delivery Mgr ─┐  │
│   │persona│   │  persona    │   │persona│   │persona│  │   persona       │  │
│   │+ tools│   │  + tools    │   │+ sandbox│ │+ tools│  │   + tools       │  │
│   └───┬───┘   └──────┬──────┘   └───┬────┘  └──┬───┘   └────────┬────────┘  │
└───────┼──────────────┼──────────────┼──────────┼───────────────┼──────────┘
        │              │              │          │               │
        ▼              ▼              ▼          ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ ┌──────────────────────┐
│ GATEWAY DE   │ │ FERRAMENTAS  │ │ SANDBOX (microVM │ │ APROVAÇÕES           │
│ MODELOS      │ │ via MCP:     │ │  efêmera por     │ │ (Slack: botões       │
│ LiteLLM +    │ │ Slack/Linear/│ │  tarefa — E2B/   │ │  Aprovar/Recusar em  │
│ passthrough  │ │ GitHub/busca │ │  Daytona)        │ │  pontos-chave)       │
│ + RouteLLM   │ │ + cred proxy │ │  git/testes/PR   │ └──────────────────────┘
└──────────────┘ └──────────────┘ └──────────────────┘
        │
        ▼
┌──────────────────────────────┐  ┌──────────────────────────────┐
│ ESTADO / MEMÓRIA              │  │ OBSERVABILIDADE              │
│ Postgres (estado dos agentes)│  │ OpenLLMetry → Langfuse       │
│ + pgvector (memória longa)   │  │ custo/trace/eval, cache-hit  │
└──────────────────────────────┘  └──────────────────────────────┘
```

**Princípios:**
- **Tudo é evento.** Mensagem no Slack, ticket criado/atribuído, PR aberto/comentado, CI finalizado →
  vira evento normalizado na fila. Agentes não rodam em sequência fixa; reagem.
- **Delegação = ação observável.** Quando o PM "passa pro Dev", ele **atribui o ticket no Linear** e/ou
  **@menciona o Dev no Slack**. Isso gera um evento que acorda o agente Dev. A coordenação é a própria
  troca de mensagens/tickets — você vê tudo acontecendo.
- **Idempotência e dedupe.** Webhooks repetem; cada evento tem ID e é processado uma vez.
- **Stateless workers + estado externo.** Agentes são workers sem estado; o estado vive em
  Postgres/Linear/Slack → escala horizontal barato (serverless-friendly).

---

## 4. Autonomia com aprovação em pontos-chave

Decisão fechada: agentes agem sozinhos no dia a dia, mas **pedem seu OK em momentos críticos**. A
aprovação acontece **no próprio Slack** (mensagem com botões "✅ Aprovar / ✏️ Ajustar / ❌ Recusar"),
mantendo a experiência conversacional.

| Ação | Autônomo? |
|---|---|
| Ler repositório, investigar bug, fazer perguntas no Slack | ✅ sozinho |
| Criar/editar ticket no Linear, comentar, organizar | ✅ sozinho |
| Delegar entre agentes (atribuir ticket, @mencionar) | ✅ sozinho |
| Rodar testes/análise no sandbox | ✅ sozinho |
| **Abrir PR** | ⚠️ pede aprovação |
| **Mexer em produção / rodar migration / deploy** | ⚠️ pede aprovação |
| **Fechar ticket / marcar como entregue** | ⚠️ pede aprovação |
| Qualquer ação destrutiva ou irreversível | ⚠️ pede aprovação |

Tecnicamente, isso é uma **interrupção durável**: o agente chega no ponto-chave, posta o pedido de
aprovação no Slack, **pausa o workflow** (estilo `interrupt_before` do LangGraph / `always_ask` do
toolset) e só retoma quando você clica. Casa com a confiabilidade real (~45–55%) que a pesquisa mostrou
— o humano valida os pontos onde o erro é caro.

---

## 5. Independência de provedor (multi-modelo)

Inalterado em relação à pesquisa — só reforçando como entra aqui:
- **Gateway LiteLLM self-hosted** como denominador comum (formato OpenAI), **+ passthrough nativo**
  (`/v1/messages` p/ Claude) para tool-calling paralelo, prompt caching e structured output.
- **Cada agente escolhe seu modelo** por config (PM barato, Dev no topo). O **RouteLLM** pode rebaixar
  para modelo barato em tarefas simples dentro de um papel.
- **Manus** entra como **"agente externo"** (adapter de tarefa assíncrona), não como modelo de chat.
- **Ollama/vLLM** para modelos locais já vêm nativos no LiteLLM.

---

## 6. Conexão com repositórios e segurança

- **Execução:** **microVM efêmera por tarefa** (E2B/Daytona) — criada quando o Dev pega a demanda,
  destruída ao terminar. Só o agente Dev precisa de sandbox; PM/QA leem via API/MCP.
- **GitHub:** GitHub App (tokens de 1h), permissões mínimas por repo; webhooks de issue/PR/CI viram
  eventos.
- **Segurança (não opcional):** tratar **todo conteúdo de Slack/Linear/GitHub como não confiável**
  (prompt injection via mensagem/ticket/PR já vazou segredos em produtos reais). **Segredos nunca no
  container** → credential proxy. Egress default-deny + allowlist. Canários + log de toda tool-call.

---

## 7. Ferramentas via MCP

Slack, Linear e GitHub entram como **MCP servers** (padrão de facto de ferramentas), rodando **no nosso
perímetro** (não SaaS de terceiros), com version-pinning e `mcp-scan` no CI. Cada papel recebe só as
ferramentas que precisa (PM: Slack+Linear+GitHub-read; Dev: +sandbox+GitHub-write). A delegação
agente→agente no MVP é **via Slack/Linear** (não precisa de A2A formal ainda); A2A entra depois se a
comunicação entre agentes crescer além das ferramentas humanas.

---

## 8. Walkthrough do exemplo-guia (bug → entrega)

1. **Você (Slack):** "@pm tem um bug: usuários não conseguem resetar senha em produção."
2. **PM** (evento: menção) → lê a thread, usa GitHub-read para **procurar no repo** o fluxo de reset,
   faz 1 pergunta se necessário ("acontece em todos os browsers?"), e **cria ticket no Linear** com
   título, descrição, passos de reprodução e critérios de aceite. Posta no Slack: "criei o LIN-123,
   investiguei e parece ser no `resetToken`. Passando pro dev."
3. **PM delega** → **atribui LIN-123 ao agente Dev** no Linear (+ @menção no Slack). Isso gera evento.
4. **Dev** (evento: ticket atribuído) → cria **microVM efêmera**, clona o repo, reproduz o bug, implementa
   a correção, roda os testes. Chega no ponto-chave **"abrir PR"** → **pede aprovação no Slack**:
   "corrigi o `resetToken` (expirava cedo demais), testes passando. Abro o PR? [✅/✏️/❌]".
5. **Você aprova** → Dev abre o PR, comenta no ticket, e o **QA** (evento: PR aberto) roda a verificação.
6. **Delivery Manager** acompanha o status e, quando o PR é mergeado (com sua aprovação), **resume a
   entrega** no Slack e move o ticket para "Done".

Tudo **visível e conversável** — você pode entrar em qualquer ponto e redirecionar.

---

## 9. Stack de referência (TS-first)

| Camada | Escolha |
|---|---|
| Runtime de agentes | TypeScript (Node) — workers reativos a eventos |
| Orquestração de fluxo / interrupções | LangGraph.js (durable + `interrupt_before`) ou máquina de estados própria; **Temporal** se precisar de durabilidade forte |
| Event bus / fila | Redis + BullMQ (MVP) → Temporal (escala) |
| Conectores | Slack (Bolt/Events API), Linear (SDK + webhooks), GitHub (App + webhooks) |
| Gateway de modelos | LiteLLM self-hosted + passthrough + RouteLLM |
| Ferramentas | MCP servers (Slack/Linear/GitHub/busca) + credential proxy |
| Sandbox | E2B ou Daytona (microVM por tarefa) |
| Estado/memória | Postgres + pgvector |
| Observabilidade | OpenLLMetry/OTel → Langfuse |
| Frontend (depois) | Next.js + Vercel AI SDK (painel de squads/aprovações; Slack é a UI primária no MVP) |

---

## 10. Roadmap de MVP faseado (revisado para esta visão)

**Fase 0 — Um agente conversacional no Slack (PM) + Linear + GitHub-read**
- Bot no Slack que recebe linguagem natural, normaliza eventos, e tem **memória da thread**.
- Agente **PM**: investiga (GitHub-read), conversa, e **cria/edita ticket no Linear**.
- Gateway LiteLLM (1 provedor) + observabilidade (custo por run) desde já.
- *Resultado demonstrável:* "falo um bug no Slack → vira um ticket bem refinado no Linear."

**Fase 1 — Delegação + agente Dev com sandbox + aprovação**
- PM **delega** ao Dev (atribui ticket + @menção → evento).
- Agente **Dev**: microVM efêmera, implementa, roda testes, **pede aprovação no Slack** antes de abrir PR.
- GitHub App + credential proxy + egress allowlist.
- *Resultado:* "bug no Slack → ticket → Dev corrige → aprovo → PR aberto." Fluxo ponta-a-ponta.

**Fase 2 — Multi-provedor + roteamento + QA**
- Adicionar OpenAI/Gemini via gateway; prompt caching; RouteLLM por tier (PM barato, Dev topo).
- Agente **QA**: roda testes/análise no PR (graders determinísticos) + gate no CI.
- Budget enforcement ativo no gateway.

**Fase 3 — Squad completa + memória + hardening**
- Tech Lead e Delivery Manager. Memória de longo prazo (pgvector) e compaction.
- MCP servers no perímetro + mcp-scan; canários; eval set crescente; validar com SWE-bench Pro.

**Fase 4 — Ecossistema e escala**
- Adapter Manus (tarefa assíncrona), Ollama/vLLM (local), A2A (faseado).
- Jira além de Linear; multi-org via GitHub App; painel web + billing por consumo.

---

## 11. Riscos específicos desta arquitetura

| Risco | Mitigação |
|---|---|
| **Loop de agentes conversando entre si sem fim** (PM↔Dev "pingando") | Limites de profundidade de delegação; só humano inicia novos ciclos; circuit breaker por ticket. |
| **Prompt injection via mensagem/ticket/PR** | Conteúdo externo como não confiável; credential proxy; ações destrutivas sempre com aprovação. |
| **Ruído no Slack** (agentes tagarelas) | Política de verbosidade; resumir em vez de narrar cada passo; threads em vez de canal. |
| **Custo fugindo** (cada turn rebilha histórico — O(N²)) | Prompt caching, compaction, budget por sessão/ticket no gateway. |
| **Identidade/permissão dos bots** | Cada agente com escopo mínimo no Slack/Linear/GitHub; auditoria de toda ação. |
| **Expectativa de autonomia total** | Aprovação em pontos-chave por padrão; deixar claro que é "time que acelera", com humano no comando. |

---

> **Resumo:** a visão é um **time de plantão, conversável e observável**, não um pipeline. Agentes são
> personas persistentes que reagem a eventos nas ferramentas humanas (Slack/Linear/GitHub), delegam
> visivelmente entre si, e pedem aprovação nos pontos caros. A pesquisa sustenta esse desenho —
> especialmente porque a observabilidade no Slack ataca o ponto mais fraco de sistemas multiagente.

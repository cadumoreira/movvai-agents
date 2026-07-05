import "dotenv/config";
import { startDashboard } from "../web/server.js";
import { track } from "../board/board.js";
import { register } from "../approvals/registry.js";
import { askQuestion, answerQuestion } from "../approvals/questions.js";

/**
 * Demo do kanban: sobe o painel e simula os dois squads trabalhando — cards andando
 * por Fila → Em atuação → Aguardando aprovação → Concluído. As aprovações são REAIS
 * (mesmo registro central): aprove/recuse pelos botões do painel e veja o card andar.
 *
 *   npm run demo:board   → abra http://localhost:3000
 *
 * Não gasta tokens nem exige chave nenhuma — é só o fluxo de estado do board.
 */

const port = Number(process.env.DASHBOARD_PORT || "3000");
startDashboard(port);
console.log(`\nDemo do board: abra http://localhost:${port} e acompanhe o kanban.\n`);

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

const threadKeyOf = (cardKey: string) => cardKey.slice(0, cardKey.lastIndexOf(":"));

/** Portão de aprovação da demo: pendura no registro central e espera o clique no painel. */
async function approvalStep(cardKey: string, text: string): Promise<boolean> {
  track(cardKey, { column: "aprovacao" }, "pediu OK humano — decida no painel (ou direto no card)");
  console.log(`⏸  Aguardando aprovação no painel: "${text}"`);
  const { promise } = register(text, threadKeyOf(cardKey));
  const d = await promise;
  track(cardKey, { column: "execucao" }, d.approved ? "aprovado pelo humano" : "recusado pelo humano");
  return d.approved;
}

/** Pergunta de esclarecimento da demo: responda no card do painel (45s até seguir com o padrão). */
async function questionStep(cardKey: string, askedBy: string, question: string): Promise<string> {
  track(cardKey, { column: "aprovacao" }, `perguntou: ${question}`);
  console.log(`⏸  Pergunta no painel (45s): "${question}"`);
  const answered = await Promise.race([
    askQuestion(threadKeyOf(cardKey), question, askedBy),
    sleep(45).then(() => null),
  ]);
  if (answered === null) answerQuestion(threadKeyOf(cardKey), "(sem resposta — seguindo com o padrão)", "demo:timeout");
  const answer = answered ?? "(sem resposta — seguindo com o padrão)";
  track(cardKey, { column: "execucao" }, `resposta: ${answer.slice(0, 60)}`);
  return answer;
}

async function squadProduto(run: number): Promise<void> {
  const t = (suffix: string) => `demo:${run}:${suffix}`;
  const title = "Bug: reset de senha não envia e-mail";

  track(t("pm"), { title, agent: "Ana (PM)", squad: "produto", column: "execucao" }, "menção recebida no Slack");
  await sleep(3);
  track(t("pm"), { column: "concluido", outcome: "ok" }, "ticket criado no Linear; delegado ao Tech Lead");

  track(t("techlead"), { title, agent: "Rui (Tech Lead)", squad: "produto", column: "fila" }, "demanda delegada");
  await sleep(2);
  track(t("techlead"), { column: "execucao" }, "desenhando a abordagem técnica");
  await sleep(5);
  track(t("techlead"), { column: "concluido", outcome: "ok" }, "abordagem registrada no ticket");

  track(t("dev"), { title, agent: "Téo (Dev)", squad: "produto", column: "fila" }, "demanda delegada ao Dev");
  await sleep(2);
  track(t("dev"), { column: "execucao" }, "implementando no sandbox (testes verdes)");
  await sleep(6);
  const approved = await approvalStep(t("dev"), `Téo (Dev): testes verdes em "${title}" — posso abrir o PR?`);
  if (!approved) {
    track(t("dev"), { column: "concluido", outcome: "recusado" }, "PR recusado — frente encerrada");
    return;
  }
  await sleep(2);
  track(t("dev"), { column: "concluido", outcome: "ok" }, "PR #42 aberto");

  track(t("qa"), { title, agent: "Bia (QA)", squad: "produto", column: "execucao" }, "revisando o PR #42");
  await sleep(5);
  track(t("qa"), { column: "concluido", outcome: "ok" }, "revisão registrada: aprovado");

  track(t("delivery"), { title, agent: "Dani (Delivery)", squad: "produto", column: "execucao" }, "resumindo a entrega");
  await sleep(3);
  track(t("delivery"), { column: "concluido", outcome: "ok" }, "resumo publicado na thread");
}

async function squadMarketing(run: number): Promise<void> {
  const t = (suffix: string) => `demo:${run}:${suffix}`;
  const title = "Campanha de lançamento do plano Pro";

  track(t("marketing-lead"), { title, agent: "Malu (Head de Marketing)", squad: "marketing", column: "fila" }, "demanda delegada pela Ana");
  await sleep(2);
  track(t("marketing-lead"), { column: "execucao" }, "lendo a demanda");
  await sleep(2);
  await questionStep(t("marketing-lead"), "Malu (Head de Marketing)", "Qual é o público prioritário da campanha?");
  track(t("marketing-lead"), { column: "execucao" }, "montando o brief no Notion");
  await sleep(5);
  track(t("marketing-lead"), { column: "concluido", outcome: "ok" }, "brief pronto; frentes acionadas");

  const social = (async () => {
    track(t("mkt-social"), { title, agent: "Sofia (Social)", squad: "marketing", column: "fila" }, "frente delegada");
    await sleep(2);
    track(t("mkt-social"), { column: "execucao" }, "escrevendo posts por canal");
    await sleep(6);
    const ok = await approvalStep(t("mkt-social"), `Sofia (Social): calendário de "${title}" pronto — posso publicar?`);
    track(
      t("mkt-social"),
      { column: "concluido", outcome: ok ? "ok" : "recusado" },
      ok ? "calendário aprovado e registrado" : "publicação recusada",
    );
  })();

  const conteudo = (async () => {
    track(t("mkt-conteudo"), { title, agent: "Caio (Conteúdo)", squad: "marketing", column: "fila" }, "frente delegada");
    await sleep(3);
    track(t("mkt-conteudo"), { column: "execucao" }, "escrevendo o artigo de lançamento");
    await sleep(8);
    track(t("mkt-conteudo"), { column: "concluido", outcome: "ok" }, "rascunho salvo no Notion");
  })();

  await Promise.all([social, conteudo]);
}

let run = 0;
for (;;) {
  run += 1;
  console.log(`▶  Cenário ${run} começando…`);
  await Promise.all([squadProduto(run), squadMarketing(run)]);
  console.log(`✓  Cenário ${run} concluído — próximo em 30s (Ctrl+C para sair).`);
  await sleep(30);
}

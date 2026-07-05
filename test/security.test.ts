import { test } from "node:test";
import assert from "node:assert/strict";
import { isFetchableUrl, isPrivateIp, resolvesToPublicIp } from "../src/tools/web.js";
import { publishTools, normalizeForApproval, type PublishGate } from "../src/tools/publish-tools.js";
import { sendEmailResend } from "../src/publish/publishers.js";
import { startDashboard } from "../src/web/server.js";

// ── Guarda anti-SSRF: vetores de bypass conhecidos ──────────────────────────

test("isFetchableUrl: bloqueia IP em formato alternativo (decimal/octal/hex)", () => {
  assert.equal(isFetchableUrl("http://2130706433/"), false); // 127.0.0.1 em decimal
  assert.equal(isFetchableUrl("http://0177.0.0.1/"), false); // octal
  assert.equal(isFetchableUrl("http://0x7f.0.0.1/"), false); // hex
});

test("isFetchableUrl: bloqueia IPv6 local em qualquer grafia", () => {
  assert.equal(isFetchableUrl("http://[::1]/"), false);
  assert.equal(isFetchableUrl("http://[0:0:0:0:0:0:0:1]/"), false);
  assert.equal(isFetchableUrl("http://[::ffff:127.0.0.1]/"), false);
  assert.equal(isFetchableUrl("http://[::ffff:169.254.169.254]/"), false);
  assert.equal(isFetchableUrl("http://[fe80::1]/"), false);
  assert.equal(isFetchableUrl("http://[fc00::2]/"), false);
});

test("isFetchableUrl: bloqueia nomes internos e metadados de nuvem", () => {
  assert.equal(isFetchableUrl("http://metadata.google.internal/computeMetadata/v1/"), false);
  assert.equal(isFetchableUrl("http://intranet.internal/"), false);
  assert.equal(isFetchableUrl("http://impressora.local/"), false);
});

test("isFetchableUrl: bloqueia CGNAT e faixas reservadas", () => {
  assert.equal(isFetchableUrl("http://100.64.0.1/"), false);
  assert.equal(isFetchableUrl("http://0.0.0.0/"), false);
  assert.equal(isFetchableUrl("http://198.18.0.1/"), false);
  assert.equal(isFetchableUrl("http://224.0.0.1/"), false);
});

test("isFetchableUrl: continua aceitando a web pública", () => {
  assert.equal(isFetchableUrl("https://concorrente.com/pricing"), true);
  assert.equal(isFetchableUrl("http://8.8.8.8/"), true);
  assert.equal(isFetchableUrl("https://[2001:4860:4860::8888]/"), true);
});

test("isPrivateIp: faixas privadas/reservadas por família", () => {
  for (const ip of ["10.1.2.3", "172.31.0.1", "192.168.0.1", "169.254.169.254", "127.0.0.1", "100.100.0.1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["::1", "::", "fe80::1", "fd12::1", "::ffff:10.0.0.1", "64:ff9b::a00:1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
  assert.equal(isPrivateIp("não é ip"), true, "formato desconhecido bloqueia");
});

// ── Portão de publicação vinculado ao conteúdo aprovado ─────────────────────

test("publicar corpo DIFERENTE do entregável aprovado é bloqueado", async () => {
  const gate: PublishGate = {
    approved: true,
    approvedContent: normalizeForApproval("# Post\n\nTexto que o humano aprovou.\n\nCTA final."),
  };
  const tools = publishTools("social", { gate, personaId: "mkt-social" });
  const publish = (tools.schedule_social_post as { execute: (a: unknown, b: unknown) => Promise<{ ok: boolean; error?: string }> }).execute;

  const divergente = await publish({ title: "x", content: "Texto trocado depois da aprovação" }, {});
  assert.equal(divergente.ok, false);
  assert.match(divergente.error ?? "", /difere do entregável aprovado/);

  // corpo contido no aprovado passa o portão (falha depois só por webhook não configurado)
  const fiel = await publish({ title: "x", content: "Texto que o humano aprovou." }, {});
  assert.doesNotMatch(fiel.error ?? "", /difere|aprovação humana/);
});

test("gate aprovado SEM conteúdo registrado continua travado", async () => {
  const gate: PublishGate = { approved: true }; // approvedContent ausente
  const tools = publishTools("conteudo", { gate, personaId: "mkt-conteudo" });
  const res = await (tools.publish_blog_post as { execute: (a: unknown, b: unknown) => Promise<{ ok: boolean; error?: string }> }).execute(
    { title: "x", markdown: "corpo qualquer" },
    {},
  );
  assert.equal(res.ok, false);
});

test("send_email_campaign: destinatário fora da allowlist EMAIL_TO é recusado", async () => {
  const res = await sendEmailResend({ subject: "oi", markdown: "corpo", to: ["atacante@evil.com"] });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /allowlist EMAIL_TO/);
});

test("resolvesToPublicIp: hostname que resolve para loopback é barrado", async () => {
  assert.equal(await resolvesToPublicIp("localhost"), false);
  assert.equal(await resolvesToPublicIp("127.0.0.1"), false);
  assert.equal(await resolvesToPublicIp("8.8.8.8"), true);
  assert.equal(await resolvesToPublicIp("host-que-nao-existe.invalid"), false, "erro de DNS falha fechado");
});

// ── Painel: leituras sensíveis exigem o token quando configurado ─────────────

test("com DASHBOARD_TOKEN, /api/audit, /api/billing e /api/docs exigem Bearer", async () => {
  process.env.DASHBOARD_TOKEN = "segredo-teste";
  const server = startDashboard(0);
  await new Promise((r) => server.once("listening", r));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  try {
    for (const route of ["/api/audit", "/api/billing", "/api/docs", "/api/docs/content?type=brand&id=perfil"]) {
      const anon = await fetch(`${base}${route}`);
      assert.equal(anon.status, 401, `${route} sem token`);
    }
    const authed = await fetch(`${base}/api/billing`, { headers: { Authorization: "Bearer segredo-teste" } });
    assert.equal(authed.status, 200, "com token passa");
    // board segue aberto (operacional, alimenta a visão ao vivo)
    const board = await fetch(`${base}/api/board`);
    assert.equal(board.status, 200);
  } finally {
    delete process.env.DASHBOARD_TOKEN;
    await new Promise((r) => server.close(r));
  }
});

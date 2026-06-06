import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

/**
 * Observabilidade agnóstica via OpenTelemetry. Exporta spans (incluindo os do Vercel AI
 * SDK) por OTLP — Langfuse, Phoenix, etc. ingerem o mesmo formato, evitando lock-in.
 *
 * Liga-se por configuração:
 *  - LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY (+ opcional LANGFUSE_BASEURL), ou
 *  - OTEL_EXPORTER_OTLP_ENDPOINT (config padrão do OTel por env).
 * Sem nada disso, fica desligado (no-op) — o projeto roda local sem backend de tracing.
 */
let enabled = false;

function buildExporter(): OTLPTraceExporter | undefined {
  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_SECRET_KEY;
  if (pub && sec) {
    const base = process.env.LANGFUSE_BASEURL || "https://cloud.langfuse.com";
    const auth = Buffer.from(`${pub}:${sec}`).toString("base64");
    return new OTLPTraceExporter({
      url: `${base}/api/public/otel/v1/traces`,
      headers: { Authorization: `Basic ${auth}` },
    });
  }
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return new OTLPTraceExporter(); // lê a config padrão do OTel via env
  }
  return undefined;
}

export function initTelemetry(): void {
  const exporter = buildExporter();
  if (!exporter) return;

  const sdk = new NodeSDK({
    traceExporter: exporter,
    serviceName: "movvai-agents",
  });
  sdk.start();
  enabled = true;

  const shutdown = () => {
    void sdk.shutdown();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  console.log(JSON.stringify({ level: "info", kind: "telemetry", status: "on", at: new Date().toISOString() }));
}

export function telemetryEnabled(): boolean {
  return enabled;
}

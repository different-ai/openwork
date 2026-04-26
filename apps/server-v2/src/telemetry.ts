let shutdownFn: (() => Promise<void>) | null = null;

export async function initTelemetry(serviceName = "openwork-server-v2"): Promise<void> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return;
  }

  if (shutdownFn) {
    return;
  }

  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { resourceFromAttributes } = await import("@opentelemetry/resources");

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({ "service.name": serviceName }),
      traceExporter: new OTLPTraceExporter(),
    });

    sdk.start();

    shutdownFn = () => sdk.shutdown();

    console.info(
      JSON.stringify({
        scope: "openwork-server-v2.telemetry",
        message: `OTEL tracing enabled, exporting to ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`,
      }),
    );
  } catch {
    console.info(
      JSON.stringify({
        scope: "openwork-server-v2.telemetry",
        message: "OTEL packages not found, tracing disabled",
      }),
    );
  }
}

const SHUTDOWN_TIMEOUT_MS = 5_000;

export async function shutdownTelemetry(): Promise<void> {
  if (!shutdownFn) return;

  const fn = shutdownFn;
  shutdownFn = null;

  await Promise.race([
    fn(),
    new Promise<void>((r) => {
      const timer = setTimeout(r, SHUTDOWN_TIMEOUT_MS);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    }),
  ]);
}

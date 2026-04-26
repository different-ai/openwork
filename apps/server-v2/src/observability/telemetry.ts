let activeShutdown: (() => Promise<void>) | null = null;

export function isTelemetryConfigured(): boolean {
  if (isTruthy(process.env.OTEL_SDK_DISABLED)) return false;
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

export async function initTelemetry(): Promise<boolean> {
  if (activeShutdown) return true;
  if (!isTelemetryConfigured()) return false;

  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-http"
    );
    const { resourceFromAttributes } = await import(
      "@opentelemetry/resources"
    );

    const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || "openwork-server-v2";

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({ "service.name": serviceName }),
      traceExporter: new OTLPTraceExporter(),
    });
    sdk.start();
    activeShutdown = () => sdk.shutdown();
    return true;
  } catch {
    return false;
  }
}

const SHUTDOWN_TIMEOUT_MS = 5_000;

export async function shutdownTelemetry(): Promise<void> {
  const fn = activeShutdown;
  if (!fn) return;
  activeShutdown = null;

  await Promise.race([
    fn(),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    }),
  ]);
}

export function resetTelemetryStateForTesting(): void {
  activeShutdown = null;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getDenWebObservabilityConfig } = await import("./observability/server-config");
    const config = getDenWebObservabilityConfig(process.env);

    if (config.backend === "otel") {
      const { startOtel } = await import("./observability/otel-node");
      startOtel(config);
      return;
    }

    if (config.backend === "sentry") {
      await import("./sentry.server.config");
      return;
    }

    const { useJsonStdoutStructuredLogSink } = await import("./observability/runtime-logger");
    useJsonStdoutStructuredLogSink();
    return;
  }

  if (process.env.NEXT_RUNTIME === "edge" || process.env.NEXT_RUNTIME === "experimental-edge") {
    const { getDenWebObservabilityConfig } = await import("./observability/server-config");
    const config = getDenWebObservabilityConfig(process.env);

    if (config.backend === "sentry") {
      await import("./sentry.edge.config");
      return;
    }

    const { useJsonStdoutStructuredLogSink } = await import("./observability/runtime-logger");
    useJsonStdoutStructuredLogSink();
    return;
  }

  const { useJsonStdoutStructuredLogSink } = await import("./observability/runtime-logger");
  useJsonStdoutStructuredLogSink();
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const { getDenWebObservabilityConfig } = await import("./observability/server-config");
  if (getDenWebObservabilityConfig(process.env).backend !== "sentry") return;

  const Sentry = await import("@sentry/nextjs");
  return Sentry.captureRequestError(error, request, context);
};

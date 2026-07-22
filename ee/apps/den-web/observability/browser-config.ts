import { ObservabilityConfigError } from "@openwork-ee/utils/observability";

export type BrowserObservabilityConfig =
  | { backend: "none"; disabledReason?: string }
  | { backend: "sentry"; dsn: string; tracesSampleRate: number };

export type BrowserObservabilityInput = {
  backend?: string;
  sentryDsn?: string;
  sentryTracesSampleRate?: string;
};

function envValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function envKeyValue(input: BrowserObservabilityInput, key: keyof BrowserObservabilityInput): string | undefined {
  const value = envValue(input[key]);
  return value ? value : undefined;
}

function parseUnitInterval(raw: string, envKey: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ObservabilityConfigError("must be a number from 0 through 1", envKey);
  }
  return value;
}

function validatePublicSentryDsn(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ObservabilityConfigError("must be an absolute Sentry DSN", "NEXT_PUBLIC_SENTRY_DSN");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ObservabilityConfigError("must use http or https", "NEXT_PUBLIC_SENTRY_DSN");
  }
  if (!parsed.username) {
    throw new ObservabilityConfigError("must include a public key", "NEXT_PUBLIC_SENTRY_DSN");
  }
  if (!parsed.pathname.split("/").filter(Boolean).at(-1)) {
    throw new ObservabilityConfigError("must include a project id", "NEXT_PUBLIC_SENTRY_DSN");
  }

  return value;
}

export function parseBrowserObservabilityEnv(input: BrowserObservabilityInput): BrowserObservabilityConfig {
  const backend = envKeyValue(input, "backend");
  const dsn = envKeyValue(input, "sentryDsn");

  if (backend === undefined || backend === "none") {
    return {
      backend: "none",
      disabledReason: dsn === undefined
        ? undefined
        : "NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND must be sentry to enable browser Sentry.",
    };
  }

  if (backend === "otel") {
    return {
      backend: "none",
      disabledReason: "Browser OpenTelemetry is disabled; DEN OTEL is server-only.",
    };
  }

  if (backend !== "sentry") {
    throw new ObservabilityConfigError(
      "must be one of none, sentry, otel",
      "NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND",
    );
  }

  if (dsn === undefined) {
    throw new ObservabilityConfigError(
      "is required when NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND=sentry",
      "NEXT_PUBLIC_SENTRY_DSN",
    );
  }

  const sampleRate = envKeyValue(input, "sentryTracesSampleRate");

  return {
    backend: "sentry",
    dsn: validatePublicSentryDsn(dsn),
    tracesSampleRate: sampleRate === undefined
      ? 1
      : parseUnitInterval(sampleRate, "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE"),
  };
}

export function getBrowserObservabilityConfigFromPublicEnv(): BrowserObservabilityConfig {
  return parseBrowserObservabilityEnv({
    backend: process.env.NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND,
    sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    sentryTracesSampleRate: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
  });
}

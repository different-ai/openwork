function envValue(env, key) {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseServerBackend(env) {
  const backend = envValue(env, "DEN_OBSERVABILITY_BACKEND") || "none";

  if (backend === "none" || backend === "otel" || backend === "sentry") {
    return backend;
  }

  throw new Error("DEN_OBSERVABILITY_BACKEND must be one of none, otel, sentry.");
}

function parsePublicBrowserBackend(env) {
  const publicBackend = envValue(env, "NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND");

  if (publicBackend === undefined || publicBackend === "none" || publicBackend === "otel" || publicBackend === "sentry") {
    return publicBackend || "none";
  }

  throw new Error("NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND must be one of none, sentry, otel.");
}

function validateSentryDsn(value, key) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute Sentry DSN.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${key} must use http or https.`);
  }
  if (!parsed.username) {
    throw new Error(`${key} must include a public key.`);
  }
  if (!parsed.pathname.split("/").filter(Boolean).at(-1)) {
    throw new Error(`${key} must include a project id.`);
  }
}

function validateHttpUrl(value, key) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute http(s) URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${key} must use http or https.`);
  }
}

function validateUnitInterval(value, key) {
  if (value === undefined) return;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
    throw new Error(`${key} must be a number from 0 through 1.`);
  }
}

function parseBooleanFlag(env, key) {
  const value = envValue(env, key);
  if (value === undefined) return false;

  switch (value.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${key} must be true or false.`);
  }
}

function completeSentryBuildCredentials(env) {
  return envValue(env, "SENTRY_AUTH_TOKEN") !== undefined
    && envValue(env, "SENTRY_ORG") !== undefined
    && envValue(env, "SENTRY_PROJECT") !== undefined;
}

function missingSentryBuildCredentials(env) {
  return ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"].filter((key) => envValue(env, key) === undefined);
}

function validateBuildObservabilityEnv(env) {
  const serverBackend = parseServerBackend(env);
  const browserBackend = parsePublicBrowserBackend(env);
  const publicDsn = envValue(env, "NEXT_PUBLIC_SENTRY_DSN");
  const sourceMapUploadsEnabled = parseBooleanFlag(env, "DEN_WEB_UPLOAD_SENTRY_SOURCEMAPS");

  const sentryUrl = envValue(env, "SENTRY_URL");
  if (browserBackend === "sentry") {
    if (publicDsn === undefined) {
      throw new Error("NEXT_PUBLIC_SENTRY_DSN is required when NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND=sentry.");
    }
    validateSentryDsn(publicDsn, "NEXT_PUBLIC_SENTRY_DSN");
  }

  if (sourceMapUploadsEnabled) {
    const missingCredentials = missingSentryBuildCredentials(env);
    if (missingCredentials.length > 0) {
      throw new Error(`DEN_WEB_UPLOAD_SENTRY_SOURCEMAPS=true requires ${missingCredentials.join(", ")}.`);
    }
    if (sentryUrl !== undefined) {
      validateHttpUrl(sentryUrl, "SENTRY_URL");
    }
  }

  validateUnitInterval(envValue(env, "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE"), "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE");
  validateUnitInterval(envValue(env, "SENTRY_TRACES_SAMPLE_RATE"), "SENTRY_TRACES_SAMPLE_RATE");

  return {
    serverBackend,
    browserBackend,
    browserEffectiveBackend: browserBackend === "sentry" ? "sentry" : "none",
    sentryConfigWrapEnabled: browserBackend === "sentry" || sourceMapUploadsEnabled,
    sourceMapUploadsEnabled,
  };
}

function validateBrowserObservabilityEnv(env) {
  return validateBuildObservabilityEnv(env);
}

function shouldUploadSentrySourceMaps(env) {
  return validateBuildObservabilityEnv(env).sourceMapUploadsEnabled;
}

function loadWithSentryConfig() {
  return require("@sentry/nextjs").withSentryConfig;
}

function withObservabilityNextConfig(nextConfig, env = process.env, sentryConfigWrapper) {
  const plan = validateBuildObservabilityEnv(env);

  if (!plan.sentryConfigWrapEnabled) {
    return nextConfig;
  }

  const wrap = sentryConfigWrapper || loadWithSentryConfig();
  const release = envValue(env, "SENTRY_RELEASE");
  const dist = envValue(env, "SENTRY_DIST");
  const sentryOptions = {
    telemetry: false,
    silent: envValue(env, "CI") === undefined,
    sourcemaps: { disable: !plan.sourceMapUploadsEnabled },
    release: {
      create: plan.sourceMapUploadsEnabled,
      finalize: plan.sourceMapUploadsEnabled,
    },
    widenClientFileUpload: plan.sourceMapUploadsEnabled,
    disableLogger: true,
    automaticVercelMonitors: false,
    bundleSizeOptimizations: {
      excludeDebugStatements: true,
      excludeReplayIframe: true,
      excludeReplayShadowDom: true,
      excludeReplayWorker: true,
    },
  };

  if (plan.sourceMapUploadsEnabled) {
    sentryOptions.org = envValue(env, "SENTRY_ORG");
    sentryOptions.project = envValue(env, "SENTRY_PROJECT");
    sentryOptions.authToken = envValue(env, "SENTRY_AUTH_TOKEN");
    sentryOptions.sentryUrl = envValue(env, "SENTRY_URL");
  }
  if (release !== undefined) {
    sentryOptions.release.name = release;
  }
  if (dist !== undefined) {
    sentryOptions.release.dist = dist;
  }

  return wrap(nextConfig, sentryOptions);
}

module.exports = {
  completeSentryBuildCredentials,
  parsePublicBrowserBackend,
  parseServerBackend,
  validateBuildObservabilityEnv,
  shouldUploadSentrySourceMaps,
  validateBrowserObservabilityEnv,
  withObservabilityNextConfig,
};

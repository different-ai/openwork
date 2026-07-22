"use client";

import * as Sentry from "@sentry/nextjs";
import NextError from "next/error";
import { useEffect } from "react";

import { parseBrowserObservabilityEnv } from "../observability/browser-config";

const browserObservability = parseBrowserObservabilityEnv({
  backend: process.env.NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND,
  sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  sentryTracesSampleRate: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
});

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    if (browserObservability.backend === "sentry") {
      Sentry.captureException(error);
    }
  }, [error]);

  return (
    <html lang="en">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}

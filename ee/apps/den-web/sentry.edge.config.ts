import * as Sentry from "@sentry/nextjs";

import { initSentryRuntime } from "./observability/sentry-runtime";

initSentryRuntime(Sentry);

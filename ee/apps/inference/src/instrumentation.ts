import "./load-env.js"
import { init } from "@sentry/hono/node"
import { httpIntegration } from "@sentry/node"

const dsn = process.env.SENTRY_DSN?.trim()

export const isSentryEnabled = Boolean(dsn)

if (dsn) {
  init({
    dsn,
    tracesSampleRate: 1.0,
    enableLogs: true,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
    },
    integrations(defaults) {
      return [
        ...defaults.filter((integration) => integration.name !== "Http"),
        httpIntegration({
          maxIncomingRequestBodySize: "none",
          ignoreIncomingRequestBody: () => true,
        }),
      ]
    },
  })
}

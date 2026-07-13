# otel-hono — Den services provide configurable, correlated observability

1. I start den-web and den-api with the OTEL backend and one shared collector URL. Both services become healthy, while Grafana shows them as distinct `den-web` and `den-api` services.

2. I make a real request through den-web’s proxy into den-api. Grafana displays one connected trace spanning the Next.js server and the normalized Hono route, with status and request ID but no sensitive headers or query data.

3. I open the logs view and see structured runtime logs from both services. Each request log carries its trace and span IDs, letting me jump from a log directly to the related trace.

4. I open metrics and see Hono request duration and active-request measurements for den-api. Signal-specific environment controls let me disable logs, metrics, or traces independently without affecting the application.

5. I run with observability disabled and the same application flow still works. Runtime logs fall back to structured JSON stdout, and no collector connection is attempted.

6. I select Sentry instead of OTEL and the services initialize only Sentry, never both providers. Errors, traces, and logs are captured when a DSN is configured, and production builds upload source maps only when build credentials are present.

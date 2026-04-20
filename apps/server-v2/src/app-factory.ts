import { Hono } from "hono";
import type { AppDependencies } from "./context/app-dependencies.js";
import { createAppDependencies } from "./context/app-dependencies.js";
import type { AppBindings } from "./context/request-context.js";
import { requestContextMiddleware } from "./context/request-context.js";
import { buildErrorResponse } from "./http.js";
import { errorHandlingMiddleware } from "./middleware/error-handler.js";
import { requestLoggerMiddleware } from "./middleware/request-logger.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { responseFinalizerMiddleware } from "./middleware/response-finalizer.js";
import { registerRoutes } from "./routes/index.js";

export type CreateAppOptions = {
  dependencies?: AppDependencies;
};

export function createApp(options: CreateAppOptions = {}) {
  const dependencies = options.dependencies ?? createAppDependencies();
  const app = new Hono<AppBindings>();

  app.use("*", requestIdMiddleware);
  app.use("*", requestContextMiddleware(dependencies));
  app.use("*", responseFinalizerMiddleware);
  app.use("*", requestLoggerMiddleware);
  app.use("*", errorHandlingMiddleware);

  registerRoutes(app, dependencies);

  app.notFound((c) => {
    const requestId = c.get("requestId");
    return c.json(
      buildErrorResponse({
        requestId,
        code: "not_found",
        message: `Route not found: ${new URL(c.req.url).pathname}`,
      }),
      404,
    );
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;

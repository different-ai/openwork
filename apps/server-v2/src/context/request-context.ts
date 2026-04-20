import type { Context, MiddlewareHandler } from "hono";
import type { AppDependencies } from "./app-dependencies.js";
import type { RequestActor } from "../services/auth-service.js";

export type RequestContext = {
  actor: RequestActor;
  dependencies: AppDependencies;
  receivedAt: Date;
  requestId: string;
  services: AppDependencies["services"];
};

export type AppBindings = {
  Variables: {
    requestContext: RequestContext;
    requestId: string;
  };
};

export function createRequestContext(dependencies: AppDependencies, requestId: string, headers: Headers): RequestContext {
  return {
    actor: dependencies.services.auth.resolveActor(headers),
    dependencies,
    receivedAt: new Date(),
    requestId,
    services: dependencies.services,
  };
}

export function requestContextMiddleware(dependencies: AppDependencies): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    c.set("requestContext", createRequestContext(dependencies, c.get("requestId"), c.req.raw.headers));
    await next();
  };
}

export function getRequestContext(c: Pick<Context<AppBindings>, "get">): RequestContext {
  return c.get("requestContext");
}

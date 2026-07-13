import type { ApprovalService } from "../approvals.js";
import type { ReloadEventStore } from "../events.js";
import type { TokenService } from "../tokens.js";
import type { Actor, ServerConfig } from "../types.js";

export type AuthMode = "none" | "client" | "host" | "host-token";

export interface RequestContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  config: ServerConfig;
  approvals: ApprovalService;
  reloadEvents: ReloadEventStore;
  tokens: TokenService;
  actor?: Actor;
}

/** Serializable route metadata; executable handlers remain host-local. */
export interface RouteDescriptor {
  readonly method: string;
  readonly path: string;
  readonly auth: AuthMode;
}

export interface Route extends RouteDescriptor {
  regex: RegExp;
  keys: string[];
  handler: (ctx: RequestContext) => Promise<Response>;
}

export type MatchedRoute = Route & { params: Record<string, string> };

export function matchRoute(routes: Route[], method: string, path: string): MatchedRoute | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.regex);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });
    return { ...route, params };
  }
  return null;
}

export function addRoute(routes: Route[], method: string, path: string, auth: AuthMode, handler: Route["handler"]): void {
  const keys: string[] = [];
  const regex = pathToRegex(path, keys);
  routes.push({ method, path, regex, keys, auth, handler });
}

export function describeRoutes(routes: readonly Route[]): readonly Readonly<RouteDescriptor>[] {
  return Object.freeze(routes.map((route) => Object.freeze({
    method: route.method,
    path: route.path,
    auth: route.auth,
  })));
}

function pathToRegex(path: string, keys: string[]): RegExp {
  const pattern = path.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return "([^/]+)";
  });
  return new RegExp(`^${pattern}$`);
}

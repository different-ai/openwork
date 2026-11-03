import { create } from "zustand";
import {
  AUTO_ROUTER_SESSION_ROUTES_KEY,
  AUTO_ROUTER_SESSION_ROUTES_MAX,
  autoRouterReplyRoutes,
  type AutoRouterReplyRoute,
} from "@openwork/types/den/auto-router";

const EMPTY: readonly AutoRouterReplyRoute[] = [];

function routeKey(route: AutoRouterReplyRoute) {
  return `${route.at}:${route.provider}:${route.model}:${route.thinking}`;
}

/**
 * Smart Model Router (feature `autoRouter`): the routing decisions the engine
 * recorded for each session, so the chat can say which model answered a Smart
 * reply. A
 * session snapshot and live metadata updates may arrive in either order, so
 * both merge; the list only grows, apart from the engine dropping old turns.
 */
export const useAutoRouteStore = create<{
  bySession: Record<string, readonly AutoRouterReplyRoute[]>;
  publish: (sessionId: string, routes: readonly AutoRouterReplyRoute[]) => void;
}>((set) => ({
  bySession: {},
  publish: (sessionId, routes) => set((state) => {
    if (!sessionId || routes.length === 0) return state;
    const previous = state.bySession[sessionId] ?? EMPTY;
    const merged = new Map(previous.map(route => [routeKey(route), route]));
    for (const route of routes) merged.set(routeKey(route), route);
    if (merged.size === previous.length) return state;
    const next = [...merged.values()].sort((a, b) => a.at - b.at).slice(-AUTO_ROUTER_SESSION_ROUTES_MAX * 2);
    return { bySession: { ...state.bySession, [sessionId]: next } };
  }),
}));

export function useSessionAutoRoutes(sessionId: string) {
  return useAutoRouteStore(state => state.bySession[sessionId] ?? EMPTY);
}

/** The routing decisions a native session snapshot carries, if any. */
export function autoRoutesFromSession(session: unknown): AutoRouterReplyRoute[] {
  return session && typeof session === "object"
    ? autoRouterReplyRoutes(Reflect.get(session, AUTO_ROUTER_SESSION_ROUTES_KEY))
    : [];
}

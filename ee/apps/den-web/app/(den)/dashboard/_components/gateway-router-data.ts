"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { GatewayRouterDefinition, GatewayRouterSummary } from "@openwork/types/den/gateway-router";
import { gatewayRouterSummarySchema, gatewayRouterTargetSchema } from "@openwork/types/den/gateway-router";
import { requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";

const routerSchema = gatewayRouterSummarySchema;
const targetsSchema = z.object({ targets: z.array(gatewayRouterTargetSchema) });
export type RouterTarget = z.infer<typeof targetsSchema>["targets"][number];

export class RouterRequestError extends Error {
  constructor(public status: number) {
    super(status === 401 ? "Sign in again to manage model routing."
      : status === 403 ? "Model routing is not available to your account. Ask your workspace administrator for access."
      : status === 409 ? "This router changed elsewhere. Your edits are still here. Close the editor and reopen it to load the latest version."
      : status === 404 ? "This router is no longer available. Refresh the list."
      : status === 503 ? "Model routing is disabled or temporarily unavailable. Ask your workspace administrator or try again."
      : status === 400 || status === 422 ? "Could not save these settings. Check the categories and model access, then try again."
      : "Could not reach model routing. Try again.");
  }
}

export async function routerRequest(orgId: string, suffix = "", method = "GET", body?: unknown) {
  const { response, payload } = await requestJson(`/v1/gateway-routers${suffix}`, {
    method, headers: { [ORG_SCOPE_HEADER]: orgId, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, 15000);
  if (!response.ok) throw new RouterRequestError(response.status);
  return payload;
}

export function useGatewayRouters(orgId: string) {
  return useQuery({ queryKey: ["gateway-routers", orgId], queryFn: async () => {
    const [routers, targets] = await Promise.all([routerRequest(orgId), routerRequest(orgId, "/targets")]);
    return { ...z.object({ routers: z.array(routerSchema) }).parse(routers), ...targetsSchema.parse(targets) };
  }, retry: false });
}

export async function readRouter(orgId: string, id: string) {
  return z.object({ router: routerSchema }).parse(await routerRequest(orgId, `/${encodeURIComponent(id)}`)).router;
}

export async function saveRouter(orgId: string, definition: GatewayRouterDefinition, saved: GatewayRouterSummary | null) {
  const { name, status, routes, fallbackRouteId, minConfidence } = definition;
  return z.object({ router: routerSchema }).parse(await routerRequest(orgId, saved ? `/${encodeURIComponent(saved.id)}` : "", saved ? "PUT" : "POST",
    { name, status, routes, fallbackRouteId, minConfidence, ...(saved ? { revision: saved.revision } : {}) })).router;
}

export function newRouterCategory(): GatewayRouterDefinition["routes"][number] {
  return { id: crypto.randomUUID(), description: "", inferenceProviderId: "", model: "" };
}

export function newRouter(): GatewayRouterDefinition {
  const routes = [newRouterCategory(), newRouterCategory()];
  return { name: "", status: "active", routes, fallbackRouteId: routes[0].id, minConfidence: 0.6 };
}

export function targetAvailable(route: GatewayRouterDefinition["routes"][number], targets: RouterTarget[]) {
  return targets.some(target => target.inferenceProviderId === route.inferenceProviderId && target.model === route.model);
}

export function validateRouter(draft: GatewayRouterDefinition, targets: RouterTarget[]): string | null {
  if (!draft.name.trim() || draft.name.trim().length > 100) return "Enter a router name of 1 to 100 characters.";
  if (draft.routes.length < 2 || draft.routes.length > 12) return "Use 2 to 12 prompt categories.";
  if (draft.routes.some(route => !route.description.trim() || route.description.trim().length > 1000)) return "Describe every prompt category in 1 to 1,000 characters.";
  if (draft.status === "active" && draft.routes.some(route => !targetAvailable(route, targets))) return "Choose an available model for every category.";
  if (!draft.routes.some(route => route.id === draft.fallbackRouteId)) return "Choose a fallback category.";
  if (!Number.isFinite(draft.minConfidence) || draft.minConfidence < 0 || draft.minConfidence > 1) return "Enter a minimum confidence from 0 to 1.";
  return null;
}

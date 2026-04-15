const WORKSPACE_ID_PARAMETER = ":workspaceId";

export const routeNamespaces = {
  root: "/",
  openapi: "/openapi.json",
  system: "/system",
  workspaces: "/workspaces",
} as const;

export function workspaceRoutePath(workspaceId: string = WORKSPACE_ID_PARAMETER) {
  return `${routeNamespaces.workspaces}/${workspaceId}`;
}

export const workspaceResourcePattern = workspaceRoutePath();

export const routePaths = {
  root: routeNamespaces.root,
  openapiDocument: routeNamespaces.openapi,
  system: {
    base: routeNamespaces.system,
    health: `${routeNamespaces.system}/health`,
    meta: `${routeNamespaces.system}/meta`,
    opencodeHealth: `${routeNamespaces.system}/opencode/health`,
    routerHealth: `${routeNamespaces.system}/router/health`,
    runtime: {
      summary: `${routeNamespaces.system}/runtime/summary`,
      versions: `${routeNamespaces.system}/runtime/versions`,
    },
  },
  workspaces: {
    base: routeNamespaces.workspaces,
    byId: workspaceRoutePath,
  },
} as const;

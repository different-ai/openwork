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

function workspaceSessionsBasePath(workspaceId: string = WORKSPACE_ID_PARAMETER) {
  return `${workspaceRoutePath(workspaceId)}/sessions`;
}

function workspaceSessionPath(sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) {
  return `${workspaceSessionsBasePath(workspaceId)}/${sessionId}`;
}

function workspaceSessionMessagesPath(sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) {
  return `${workspaceSessionPath(sessionId, workspaceId)}/messages`;
}

function workspaceSessionMessagePath(
  messageId: string = ":messageId",
  sessionId: string = ":sessionId",
  workspaceId: string = WORKSPACE_ID_PARAMETER,
) {
  return `${workspaceSessionMessagesPath(sessionId, workspaceId)}/${messageId}`;
}

export const workspaceResourcePattern = workspaceRoutePath();

export const routePaths = {
  root: routeNamespaces.root,
  openapiDocument: routeNamespaces.openapi,
  system: {
    base: routeNamespaces.system,
    capabilities: `${routeNamespaces.system}/capabilities`,
    health: `${routeNamespaces.system}/health`,
    meta: `${routeNamespaces.system}/meta`,
    opencodeHealth: `${routeNamespaces.system}/opencode/health`,
    routerHealth: `${routeNamespaces.system}/router/health`,
    servers: `${routeNamespaces.system}/servers`,
    status: `${routeNamespaces.system}/status`,
    runtime: {
      summary: `${routeNamespaces.system}/runtime/summary`,
      versions: `${routeNamespaces.system}/runtime/versions`,
    },
  },
  workspaces: {
    base: routeNamespaces.workspaces,
    byId: workspaceRoutePath,
    events: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/events`,
    sessions: {
      base: workspaceSessionsBasePath,
      byId: workspaceSessionPath,
      statuses: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceSessionsBasePath(workspaceId)}/status`,
      messages: {
        base: workspaceSessionMessagesPath,
        byId: workspaceSessionMessagePath,
        partById: (
          partId: string = ":partId",
          messageId: string = ":messageId",
          sessionId: string = ":sessionId",
          workspaceId: string = WORKSPACE_ID_PARAMETER,
        ) => `${workspaceSessionMessagePath(messageId, sessionId, workspaceId)}/parts/${partId}`,
      },
      promptAsync: (sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceSessionPath(sessionId, workspaceId)}/prompt_async`,
      command: (sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceSessionPath(sessionId, workspaceId)}/command`,
      shell: (sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceSessionPath(sessionId, workspaceId)}/shell`,
      todo: (sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceSessionPath(sessionId, workspaceId)}/todo`,
      status: (sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceSessionPath(sessionId, workspaceId)}/status`,
      snapshot: (sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceSessionPath(sessionId, workspaceId)}/snapshot`,
      init: (sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceSessionPath(sessionId, workspaceId)}/init`,
      fork: (sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceSessionPath(sessionId, workspaceId)}/fork`,
      abort: (sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceSessionPath(sessionId, workspaceId)}/abort`,
      share: (sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceSessionPath(sessionId, workspaceId)}/share`,
      summarize: (sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceSessionPath(sessionId, workspaceId)}/summarize`,
      revert: (sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceSessionPath(sessionId, workspaceId)}/revert`,
      unrevert: (sessionId: string = ":sessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceSessionPath(sessionId, workspaceId)}/unrevert`,
    },
  },
} as const;

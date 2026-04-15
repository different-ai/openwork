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

function workspaceFileSessionsBasePath(workspaceId: string = WORKSPACE_ID_PARAMETER) {
  return `${workspaceRoutePath(workspaceId)}/file-sessions`;
}

function workspaceFileSessionPath(fileSessionId: string = ":fileSessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) {
  return `${workspaceFileSessionsBasePath(workspaceId)}/${fileSessionId}`;
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
    createLocal: `${routeNamespaces.workspaces}/local`,
    byId: workspaceRoutePath,
    events: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/events`,
    activate: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/activate`,
    displayName: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/display-name`,
    artifacts: {
      base: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/artifacts`,
      byId: (artifactId: string = ":artifactId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceRoutePath(workspaceId)}/artifacts/${artifactId}`,
    },
    config: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/config`,
    engineReload: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/engine/reload`,
    fileSessions: {
      base: workspaceFileSessionsBasePath,
      byId: workspaceFileSessionPath,
      renew: (fileSessionId: string = ":fileSessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceFileSessionPath(fileSessionId, workspaceId)}/renew`,
      catalogSnapshot: (fileSessionId: string = ":fileSessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceFileSessionPath(fileSessionId, workspaceId)}/catalog/snapshot`,
      catalogEvents: (fileSessionId: string = ":fileSessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceFileSessionPath(fileSessionId, workspaceId)}/catalog/events`,
      readBatch: (fileSessionId: string = ":fileSessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceFileSessionPath(fileSessionId, workspaceId)}/read-batch`,
      writeBatch: (fileSessionId: string = ":fileSessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceFileSessionPath(fileSessionId, workspaceId)}/write-batch`,
      operations: (fileSessionId: string = ":fileSessionId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceFileSessionPath(fileSessionId, workspaceId)}/operations`,
    },
    inbox: {
      base: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/inbox`,
      byId: (inboxId: string = ":inboxId", workspaceId: string = WORKSPACE_ID_PARAMETER) =>
        `${workspaceRoutePath(workspaceId)}/inbox/${inboxId}`,
    },
    rawOpencodeConfig: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/config/opencode-raw`,
    reloadEvents: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/reload-events`,
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
    simpleContent: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/files/content`,
  },
} as const;

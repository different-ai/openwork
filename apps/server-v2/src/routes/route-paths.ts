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
    cloudSignin: `${routeNamespaces.system}/cloud-signin`,
    health: `${routeNamespaces.system}/health`,
    managed: {
      item: (kind: string, itemId: string = ":itemId") => `${routeNamespaces.system}/managed/${kind}/${itemId}`,
      list: (kind: string) => `${routeNamespaces.system}/managed/${kind}`,
      assignments: (kind: string, itemId: string = ":itemId") => `${routeNamespaces.system}/managed/${kind}/${itemId}/assignments`,
    },
    meta: `${routeNamespaces.system}/meta`,
    opencodeHealth: `${routeNamespaces.system}/opencode/health`,
    router: {
      apply: `${routeNamespaces.system}/router/apply`,
      bindings: `${routeNamespaces.system}/router/bindings`,
      health: `${routeNamespaces.system}/router/product-health`,
      identities: (kind: string) => `${routeNamespaces.system}/router/identities/${kind}`,
      telegram: `${routeNamespaces.system}/router/telegram`,
      send: `${routeNamespaces.system}/router/send`,
    },
    routerHealth: `${routeNamespaces.system}/router/health`,
    servers: `${routeNamespaces.system}/servers`,
    serverById: (serverId: string = ":serverId") => `${routeNamespaces.system}/servers/${serverId}`,
    serverConnect: `${routeNamespaces.system}/servers/connect`,
    serverSync: (serverId: string = ":serverId") => `${routeNamespaces.system}/servers/${serverId}/sync`,
    status: `${routeNamespaces.system}/status`,
    runtime: {
      upgrade: `${routeNamespaces.system}/runtime/upgrade`,
      summary: `${routeNamespaces.system}/runtime/summary`,
      versions: `${routeNamespaces.system}/runtime/versions`,
    },
  },
  workspaces: {
    base: routeNamespaces.workspaces,
    createLocal: `${routeNamespaces.workspaces}/local`,
    byId: workspaceRoutePath,
    dispose: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/dispose`,
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
    export: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/export`,
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
    import: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/import`,
    mcp: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/mcp`,
    plugins: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/plugins`,
    rawOpencodeConfig: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/config/opencode-raw`,
    reloadEvents: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/reload-events`,
    router: {
      base: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/opencode-router`,
      bindings: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/opencode-router/bindings`,
      health: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/opencode-router/health`,
      identities: {
        slack: (workspaceId: string = WORKSPACE_ID_PARAMETER, identityId: string = ":identityId") => `${workspaceRoutePath(workspaceId)}/opencode-router/identities/slack/${identityId}`,
        slackBase: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/opencode-router/identities/slack`,
        telegram: (workspaceId: string = WORKSPACE_ID_PARAMETER, identityId: string = ":identityId") => `${workspaceRoutePath(workspaceId)}/opencode-router/identities/telegram/${identityId}`,
        telegramBase: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/opencode-router/identities/telegram`,
      },
      send: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/opencode-router/send`,
      slackTokens: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/opencode-router/slack-tokens`,
      telegram: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/opencode-router/telegram`,
      telegramEnabled: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/opencode-router/telegram-enabled`,
      telegramToken: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/opencode-router/telegram-token`,
    },
    share: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/share`,
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
    scheduler: {
      base: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/scheduler/jobs`,
      byName: (name: string = ":name", workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/scheduler/jobs/${name}`,
    },
    skills: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/skills`,
    hubSkills: "/hub/skills",
    simpleContent: (workspaceId: string = WORKSPACE_ID_PARAMETER) => `${workspaceRoutePath(workspaceId)}/files/content`,
  },
} as const;

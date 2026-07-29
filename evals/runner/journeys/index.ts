export * from "./den.ts";
export * from "./desktop.ts";
export * from "./diagnostics.ts";
export * from "./gateway.ts";
export * from "./mcp.ts";
export * from "./sso.ts";
export * from "./update.ts";

import { acceptInvite, apiSignIn, createOrg, inviteMember, signInWeb, signUpWeb } from "./den.ts";
import { connectDen, firstBoot, openSettings, runPrompt } from "./desktop.ts";
import { createNoAuthConnection, createOAuthConnection, deleteConnection, deleteConnectionsByPrefix, disconnectConnection, executeCapability, expectUsableConnection, listConnectionTools, listManageableConnections, mcpAgentCall, mcpTextContent, mintMcpToken, openMcpConnections, reconnectNoAuthConnection, runConnectionTool, searchCapabilities, startMockMcpServer, waitForConnectionConnected } from "./mcp.ts";

export const journeys = {
  den: {
    signInWeb,
    signUpWeb,
    apiSignIn,
    createOrg,
    inviteMember,
    acceptInvite,
  },
  desktop: {
    firstBoot,
    connectDen,
    runPrompt,
    openSettings,
  },
  mcp: {
    createNoAuthConnection,
    createOAuthConnection,
    deleteConnection,
    deleteConnectionsByPrefix,
    disconnectConnection,
    executeCapability,
    expectUsableConnection,
    listConnectionTools,
    listManageableConnections,
    mcpAgentCall,
    mcpTextContent,
    mintMcpToken,
    openMcpConnections,
    reconnectNoAuthConnection,
    runConnectionTool,
    searchCapabilities,
    startMockMcpServer,
    waitForConnectionConnected,
  },
};

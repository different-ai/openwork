"use client";

import {
  SetupAppMark,
  SetupLetterTile,
  SetupNewWorkspaceTile,
  SetupStoryTile,
  SetupStoryTiles,
} from "../(den)/_components/setup-frame-parts";
import type { McpClient } from "./use-mcp-client";

/** Story-column copy for an agent's sign-in, named after the app when it shared a name. */
export function mcpStoryCopy(client: Pick<McpClient, "name">) {
  return client.name
    ? { title: `Connect ${client.name}.`, description: `${client.name} asked to use OpenWork as you.` }
    : { title: "Connect an app.", description: "An app asked to use OpenWork as you." };
}

/** The app that asked, joined to the workspace it will use (or a new one). */
export function McpStoryTiles({ client, workspaceName, appHost = null }: { client: McpClient; workspaceName: string | null; appHost?: string | null }) {
  const appLabel = client.name ?? appHost ?? "An app";
  return (
    <SetupStoryTiles
      from={{
        label: appLabel,
        mark: (
          <SetupStoryTile>
            <SetupAppMark name={client.name} logoUri={client.logoUri} size={26} />
          </SetupStoryTile>
        ),
      }}
      to={
        workspaceName
          ? { label: workspaceName, mark: <SetupLetterTile name={workspaceName} size="lg" /> }
          : { label: "New workspace", mark: <SetupNewWorkspaceTile />, pending: true }
      }
    />
  );
}

/** "Claude Code" with its mark, for the App / Signing in for fact rows. */
export function McpAppFact({ client }: { client: McpClient }) {
  return (
    <>
      <SetupAppMark name={client.name} logoUri={client.logoUri} />
      <span className="truncate" data-testid="mcp-client-name">{client.loaded ? client.name ?? "An app without a name" : "…"}</span>
    </>
  );
}

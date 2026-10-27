import { allocateFreePort } from "../../evals/packages/cdp/src/index.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";
import { connectDemoServer, startDemoScript, type DemoWorkspace } from "./demo-workspace.ts";

/**
 * Open Workplace (evals/packages/open-workplace): Open Outlook, Open Calendar, Open Drive, Open Jira and Open Confluence,
 * started next to Den and added to the org as ordinary shared MCP connections, one per app. Data stays in memory and is
 * seeded with the Acme Robotics sample organization, so whatever an agent writes can be read back from `/state`.
 */
export const OPEN_WORKPLACE_APPS = [
  { key: "open-outlook", name: "Open Outlook", service: "microsoft365", mcp: "/outlook/mcp" },
  { key: "open-calendar", name: "Open Calendar", service: "microsoft365", mcp: "/calendar/mcp" },
  { key: "open-drive", name: "Open Drive", service: "microsoft365", mcp: "/drive/mcp" },
  { key: "open-jira", name: "Open Jira", service: "atlassian", mcp: "/jira/mcp" },
  { key: "open-confluence", name: "Open Confluence", service: "atlassian", mcp: "/confluence/mcp" },
] as const;
export type OpenWorkplaceApp = (typeof OPEN_WORKPLACE_APPS)[number]["key"];

const SOURCE = new URL("../../evals/packages/open-workplace/src/", import.meta.url);
const SCRIPTS = {
  microsoft365: { url: new URL("microsoft365.mjs", SOURCE), label: "open-microsoft365", daytonaPort: 3993 },
  atlassian: { url: new URL("atlassian.mjs", SOURCE), label: "open-atlassian", daytonaPort: 3991 },
  atlassianWeb: { url: new URL("atlassian-web.mjs", SOURCE), label: "open-atlassian-web", daytonaPort: 3992 },
};

export interface OpenWorkplaceOptions {
  /** The signed-in person, "Display Name|handle|Title". Defaults to Alex Chen, the seeded Acme owner. */
  person?: string;
  /** Fixed ISO time for reproducible runs (also makes generated IDs deterministic). */
  now?: string;
  /**
   * The company's intranet domain, e.g. "acmerobotics.internal". Links then read http://office.<domain>/drive?item=… and
   * http://atlassian.<domain>/jira/browse/…; browsers reach them through `hostRules`. Local placement only.
   * Must be a reserved private name (.internal, .test, .example, .invalid, .localhost): anything that resolves on the
   * public internet would send an agent's uploads and fetches to whoever owns that domain.
   */
  domain?: string;
  /** Apps to add to the org as connections. Defaults to all five. */
  connect?: readonly OpenWorkplaceApp[];
}

export interface OpenWorkplace {
  /** Open Outlook, Open Calendar and Open Drive (Graph REST, MCP, web UI). */
  microsoft365: DemoWorkspace;
  /** Open Jira and Open Confluence (REST, MCP). */
  atlassian: DemoWorkspace;
  /** The Open Jira and Open Confluence web UI. */
  atlassianWeb: DemoWorkspace;
  /** Where a browser opens each app; public hostnames when `domain` is set. */
  urls: { outlook: string; calendar: string; drive: string; jira: string; confluence: string };
  /** Chrome --host-resolver-rules for `chrome({ hostRules })`; empty without `domain`. */
  hostRules: string;
}

export async function startOpenWorkplace(stack: AsyncDisposableStack, den: Den, options: OpenWorkplaceOptions = {}): Promise<OpenWorkplace> {
  const local = den.placement?.kind !== "daytona";
  if (options.domain && !local) throw new Error("Open Workplace hostnames need a local browser; omit `domain` on Daytona.");
  if (options.domain && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.(internal|test|example|invalid|localhost)$/.test(options.domain)) {
    throw new Error(`Open Workplace domain ${JSON.stringify(options.domain)} must be a reserved private name (.internal, .test, .example, .invalid or .localhost) so nothing can reach a real host.`);
  }
  const env: Record<string, string> = {
    ...(options.person ? { OPEN_WORKPLACE_PERSON: options.person } : {}),
    ...(options.now ? { OPEN_WORKPLACE_NOW: options.now } : {}),
  };
  // Ports are chosen first so every service can hand out its final browser address from the start.
  const officePort = local ? await allocateFreePort() : undefined;
  const webPort = local ? await allocateFreePort() : undefined;
  const office = options.domain ? `http://office.${options.domain}` : officePort ? `http://127.0.0.1:${officePort}` : undefined;
  const atlassianOrigin = options.domain ? `http://atlassian.${options.domain}` : webPort ? `http://127.0.0.1:${webPort}` : undefined;

  const microsoft365 = await startDemoScript(stack, den, { ...SCRIPTS.microsoft365, localPort: officePort }, { ...env, ...(office ? { PUBLIC_URL: office } : {}) });
  const atlassian = await startDemoScript(stack, den, SCRIPTS.atlassian, {
    ...env, ...(atlassianOrigin ? { JIRA_PUBLIC_URL: `${atlassianOrigin}/jira`, CONFLUENCE_PUBLIC_URL: `${atlassianOrigin}/confluence` } : {}),
  });
  const atlassianWeb = await startDemoScript(stack, den, { ...SCRIPTS.atlassianWeb, localPort: webPort }, { ...env, ATLASSIAN_BASE_URL: atlassian.baseUrl });

  const connect = new Set(options.connect ?? OPEN_WORKPLACE_APPS.map((app) => app.key));
  for (const app of OPEN_WORKPLACE_APPS) {
    if (!connect.has(app.key)) continue;
    const base = app.service === "microsoft365" ? microsoft365.baseUrl : atlassian.baseUrl;
    await connectDemoServer(den, app.key, app.name, `${base}${app.mcp}`);
  }

  const officeUrl = office ?? microsoft365.baseUrl;
  const atlassianUrl = atlassianOrigin ?? atlassianWeb.baseUrl;
  return {
    microsoft365, atlassian, atlassianWeb,
    urls: { outlook: `${officeUrl}/outlook`, calendar: `${officeUrl}/calendar`, drive: `${officeUrl}/drive`, jira: `${atlassianUrl}/jira`, confluence: `${atlassianUrl}/confluence` },
    hostRules: options.domain ? `MAP office.${options.domain}:80 127.0.0.1:${officePort}, MAP atlassian.${options.domain}:80 127.0.0.1:${webPort}` : "",
  };
}

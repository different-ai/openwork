// Den wire types shared across module boundaries (den.ts, den-session-events,
// openwork-server, desktop cloud sync). Extracted from den.ts so that modules
// needing only the shapes do not import the 2k-line client implementation —
// den.ts re-exports everything here, so existing imports keep working.
import type {
  OpenWorkExtensionManifest,
  OpenWorkExtensionSourceFormat,
} from "../extensions";

export type DenSettings = {
  baseUrl: string;
  apiBaseUrl?: string;
  authToken?: string | null;
  activeOrgId?: string | null;
  activeOrgSlug?: string | null;
  activeOrgName?: string | null;
};

export type DenUser = {
  id: string;
  email: string;
  name: string | null;
};

export type DenPluginConfigObjectType =
  | "skill"
  | "agent"
  | "command"
  | "tool"
  | "mcp"
  | "hook"
  | "context"
  | "custom";

export type DenPluginConfigObjectVersion = {
  id: string;
  rawSourceText: string | null;
  normalizedPayloadJson: Record<string, unknown> | null;
  sourceRevisionRef: string | null;
  createdAt: string | null;
};

export type DenPluginConfigObject = {
  id: string;
  objectType: DenPluginConfigObjectType;
  title: string;
  description: string | null;
  currentFileName: string | null;
  currentFileExtension: string | null;
  currentRelativePath: string | null;
  status: string;
  updatedAt: string | null;
  latestVersion: DenPluginConfigObjectVersion | null;
};

export type DenPluginMembership = {
  id: string;
  pluginId: string;
  configObjectId: string;
  configObject?: DenPluginConfigObject;
};

export type DenOrgExtensionProjection = {
  id: string;
  name: string;
  description: string | null;
  sourceFormat: OpenWorkExtensionSourceFormat;
  manifest: OpenWorkExtensionManifest | null;
};

export type DenOrgPlugin = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  memberCount: number;
  updatedAt: string | null;
  componentCounts: Record<string, number>;
  /** Preferred Den surface: plugins are normalized into OpenWork extensions. */
  extension?: DenOrgExtensionProjection | null;
};

export type DenOrgMarketplace = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  pluginCount: number;
  updatedAt: string | null;
};

export type DenOrgPluginResolved = {
  plugin: DenOrgPlugin;
  memberships: DenPluginMembership[];
  /** Future Den extension manifest; absent while Claude plugin imports are resource-only. */
  extension?: DenOrgExtensionProjection | null;
};

export type DenResourceSnapshotConfigItem = {
  configItemId: string;
  lastUpdatedAt: string;
};

export type DenResourceSnapshotPlugin = {
  pluginId: string;
  lastUpdatedAt: string;
  configItems: DenResourceSnapshotConfigItem[];
};

export type DenResourceSnapshotMarketplace = {
  lastUpdatedAt: string;
  plugins: DenResourceSnapshotPlugin[];
};

export type DenResourceSnapshot = {
  organizationId: string;
  orgMemberId: string;
  teamIds: string[];
  resources: {
    llmProviders: Record<string, string>;
    marketplaces: Record<string, DenResourceSnapshotMarketplace>;
  };
};

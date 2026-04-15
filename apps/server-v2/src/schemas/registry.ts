import { z } from "zod";
import { identifierSchema, isoTimestampSchema, successResponseSchema } from "./common.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const authSummarySchema = z.object({
  actorKind: z.enum(["anonymous", "client", "host"]),
  configured: z.object({
    clientToken: z.boolean(),
    hostToken: z.boolean(),
  }),
  headers: z.object({
    authorization: z.literal("Authorization"),
    hostToken: z.literal("X-OpenWork-Host-Token"),
  }),
  required: z.boolean(),
  scopes: z.object({
    hiddenWorkspaceReads: z.literal("host"),
    serverInventory: z.literal("host"),
    visibleRead: z.literal("client_or_host"),
  }),
}).meta({ ref: "OpenWorkServerV2AuthSummary" });

export const serverInventoryItemSchema = z.object({
  auth: z.object({
    configured: z.boolean(),
    scheme: z.enum(["bearer", "none"]),
  }),
  baseUrl: z.string().nullable(),
  capabilities: jsonObjectSchema,
  hostingKind: z.enum(["desktop", "self_hosted", "cloud"]),
  id: identifierSchema,
  isEnabled: z.boolean(),
  isLocal: z.boolean(),
  kind: z.enum(["local", "remote"]),
  label: z.string(),
  lastSeenAt: isoTimestampSchema.nullable(),
  source: z.string(),
  updatedAt: isoTimestampSchema,
}).meta({ ref: "OpenWorkServerV2ServerInventoryItem" });

export const registrySummarySchema = z.object({
  hiddenWorkspaceCount: z.number().int().nonnegative(),
  localServerId: identifierSchema,
  remoteServerCount: z.number().int().nonnegative(),
  totalServers: z.number().int().nonnegative(),
  visibleWorkspaceCount: z.number().int().nonnegative(),
}).meta({ ref: "OpenWorkServerV2RegistrySummary" });

export const capabilitiesDataSchema = z.object({
  auth: authSummarySchema,
  registry: z.object({
    backendResolution: z.literal(true),
    hiddenWorkspaceFiltering: z.literal(true),
    serverInventory: z.literal(true),
    workspaceDetail: z.literal(true),
    workspaceList: z.literal(true),
  }),
  runtime: z.object({
    opencodeHealth: z.literal(true),
    routerHealth: z.literal(true),
    runtimeSummary: z.literal(true),
    runtimeVersions: z.literal(true),
  }),
  transport: z.object({
    rootMounted: z.literal(true),
    sdkPackage: z.literal("@openwork/server-sdk"),
    v2: z.literal(true),
  }),
}).meta({ ref: "OpenWorkServerV2CapabilitiesData" });

const workspaceBackendSchema = z.object({
  kind: z.enum(["local_opencode", "remote_openwork"]),
  local: z.object({
    configDir: z.string().nullable(),
    dataDir: z.string().nullable(),
    opencodeProjectId: z.string().nullable(),
  }).nullable(),
  remote: z.object({
    directory: z.string().nullable(),
    hostUrl: z.string().nullable(),
    remoteType: z.enum(["openwork", "opencode"]),
    remoteWorkspaceId: z.string().nullable(),
    workspaceName: z.string().nullable(),
  }).nullable(),
  serverId: identifierSchema,
}).meta({ ref: "OpenWorkServerV2WorkspaceBackend" });

const workspaceRuntimeSummarySchema = z.object({
  backendKind: z.enum(["local_opencode", "remote_openwork"]),
  health: jsonObjectSchema.nullable(),
  lastError: jsonObjectSchema.nullable(),
  lastSessionRefreshAt: isoTimestampSchema.nullable(),
  lastSyncAt: isoTimestampSchema.nullable(),
  updatedAt: isoTimestampSchema.nullable(),
}).meta({ ref: "OpenWorkServerV2WorkspaceRuntimeSummary" });

export const workspaceSummaryDataSchema = z.object({
  backend: workspaceBackendSchema,
  createdAt: isoTimestampSchema,
  displayName: z.string(),
  hidden: z.boolean(),
  id: identifierSchema,
  kind: z.enum(["local", "remote", "control", "help"]),
  preset: z.enum(["minimal", "remote", "starter"]),
  runtime: workspaceRuntimeSummarySchema,
  server: serverInventoryItemSchema,
  slug: z.string(),
  status: z.enum(["ready", "imported", "attention"]),
  updatedAt: isoTimestampSchema,
}).meta({ ref: "OpenWorkServerV2WorkspaceSummaryData" });

export const workspaceDetailDataSchema = workspaceSummaryDataSchema.extend({
  notes: jsonObjectSchema.nullable(),
}).meta({ ref: "OpenWorkServerV2WorkspaceDetailData" });

export const workspaceListDataSchema = z.object({
  items: z.array(workspaceSummaryDataSchema),
}).meta({ ref: "OpenWorkServerV2WorkspaceListData" });

export const serverInventoryListDataSchema = z.object({
  items: z.array(serverInventoryItemSchema),
}).meta({ ref: "OpenWorkServerV2ServerInventoryListData" });

export const systemStatusDataSchema = z.object({
  auth: authSummarySchema,
  capabilities: capabilitiesDataSchema,
  database: z.object({
    bootstrapMode: z.enum(["fresh", "existing"]),
    configured: z.literal(true),
    importWarnings: z.number().int().nonnegative(),
    kind: z.literal("sqlite"),
    migrations: z.object({
      appliedThisRun: z.array(z.string()),
      currentVersion: z.string(),
      totalApplied: z.number().int().nonnegative(),
    }),
    path: z.string(),
    phaseOwner: z.literal(2),
    status: z.enum(["ready", "warning"]),
    summary: z.string(),
    workingDirectory: z.string(),
  }),
  environment: z.string(),
  registry: registrySummarySchema,
  runtime: z.object({
    opencode: z.object({
      baseUrl: z.string().nullable(),
      running: z.boolean(),
      status: z.enum(["crashed", "disabled", "error", "restart_scheduled", "running", "starting", "stopped"]),
      version: z.string().nullable(),
    }),
    router: z.object({
      baseUrl: z.string().nullable(),
      running: z.boolean(),
      status: z.enum(["crashed", "disabled", "error", "restart_scheduled", "running", "starting", "stopped"]),
      version: z.string().nullable(),
    }),
    source: z.enum(["development", "release"]),
    target: z.enum(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"]),
  }),
  service: z.literal("openwork-server-v2"),
  startedAt: isoTimestampSchema,
  status: z.literal("ok"),
  uptimeMs: z.number().int().nonnegative(),
  version: z.string(),
}).meta({ ref: "OpenWorkServerV2SystemStatusData" });

export const capabilitiesResponseSchema = successResponseSchema("OpenWorkServerV2CapabilitiesResponse", capabilitiesDataSchema);
export const serverInventoryListResponseSchema = successResponseSchema(
  "OpenWorkServerV2ServerInventoryListResponse",
  serverInventoryListDataSchema,
);
export const systemStatusResponseSchema = successResponseSchema("OpenWorkServerV2SystemStatusResponse", systemStatusDataSchema);
export const workspaceDetailResponseSchema = successResponseSchema("OpenWorkServerV2WorkspaceDetailResponse", workspaceDetailDataSchema);
export const workspaceListResponseSchema = successResponseSchema("OpenWorkServerV2WorkspaceListResponse", workspaceListDataSchema);

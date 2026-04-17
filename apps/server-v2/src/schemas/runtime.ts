import { z } from "zod";
import { isoTimestampSchema, successResponseSchema } from "./common.js";

const runtimeOutputSnapshotSchema = z.object({
  combined: z.array(z.object({
    at: isoTimestampSchema,
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
  })),
  stderr: z.array(z.string()),
  stdout: z.array(z.string()),
  totalLines: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).meta({ ref: "OpenWorkServerV2RuntimeOutputSnapshot" });

const runtimeTargetSchema = z.enum([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-arm64",
  "windows-x64",
]).meta({ ref: "OpenWorkServerV2RuntimeTarget" });

const runtimeManifestSchema = z.object({
  files: z.object({
    opencode: z.object({
      path: z.string(),
      sha256: z.string(),
      size: z.number().int().nonnegative(),
    }),
    "opencode-router": z.object({
      path: z.string(),
      sha256: z.string(),
      size: z.number().int().nonnegative(),
    }),
  }),
  generatedAt: isoTimestampSchema,
  manifestVersion: z.literal(1),
  opencodeVersion: z.string(),
  rootDir: z.string(),
  routerVersion: z.string(),
  serverVersion: z.string(),
  source: z.enum(["development", "release"]),
  target: runtimeTargetSchema,
}).meta({ ref: "OpenWorkServerV2RuntimeManifest" });

const lastExitSchema = z.object({
  at: isoTimestampSchema,
  code: z.number().int().nullable(),
  output: runtimeOutputSnapshotSchema,
  reason: z.string(),
  signal: z.string().nullable(),
}).meta({ ref: "OpenWorkServerV2RuntimeLastExit" });

const routerEnablementSchema = z.object({
  enabled: z.boolean(),
  enabledBindingCount: z.number().int().nonnegative(),
  enabledIdentityCount: z.number().int().nonnegative(),
  forced: z.boolean(),
  reason: z.string(),
}).meta({ ref: "OpenWorkServerV2RouterEnablement" });

const routerMaterializationSchema = z.object({
  bindingCount: z.number().int().nonnegative(),
  configPath: z.string(),
  dataDir: z.string(),
  dbPath: z.string(),
  identityCount: z.number().int().nonnegative(),
  logFile: z.string(),
}).meta({ ref: "OpenWorkServerV2RouterMaterialization" });

const runtimeChildStatusSchema = z.enum(["crashed", "disabled", "error", "restart_scheduled", "running", "starting", "stopped"]);

const runtimeUpgradeStateSchema = z.object({
  error: z.string().nullable(),
  finishedAt: isoTimestampSchema.nullable(),
  startedAt: isoTimestampSchema.nullable(),
  status: z.enum(["completed", "failed", "idle", "running"]),
}).meta({ ref: "OpenWorkServerV2RuntimeUpgradeState" });

export const opencodeHealthDataSchema = z.object({
  baseUrl: z.string().nullable(),
  binaryPath: z.string().nullable(),
  diagnostics: runtimeOutputSnapshotSchema,
  lastError: z.string().nullable(),
  lastExit: lastExitSchema.nullable(),
  lastReadyAt: isoTimestampSchema.nullable(),
  lastStartedAt: isoTimestampSchema.nullable(),
  manifest: runtimeManifestSchema.nullable(),
  pid: z.number().int().nullable(),
  running: z.boolean(),
  source: z.enum(["development", "release"]),
  status: runtimeChildStatusSchema,
  version: z.string().nullable(),
}).meta({ ref: "OpenWorkServerV2OpencodeHealthData" });

export const routerHealthDataSchema = z.object({
  baseUrl: z.string().nullable(),
  binaryPath: z.string().nullable(),
  diagnostics: runtimeOutputSnapshotSchema,
  enablement: routerEnablementSchema,
  healthUrl: z.string().nullable(),
  lastError: z.string().nullable(),
  lastExit: lastExitSchema.nullable(),
  lastReadyAt: isoTimestampSchema.nullable(),
  lastStartedAt: isoTimestampSchema.nullable(),
  manifest: runtimeManifestSchema.nullable(),
  materialization: routerMaterializationSchema.nullable(),
  pid: z.number().int().nullable(),
  running: z.boolean(),
  source: z.enum(["development", "release"]),
  status: runtimeChildStatusSchema,
  version: z.string().nullable(),
}).meta({ ref: "OpenWorkServerV2RouterHealthData" });

export const runtimeSummaryDataSchema = z.object({
  bootstrapPolicy: z.enum(["disabled", "eager", "manual"]),
  manifest: runtimeManifestSchema.nullable(),
  opencode: opencodeHealthDataSchema,
  restartPolicy: z.object({
    backoffMs: z.number().int().nonnegative(),
    maxAttempts: z.number().int().nonnegative(),
    windowMs: z.number().int().nonnegative(),
  }),
  router: routerHealthDataSchema,
  upgrade: runtimeUpgradeStateSchema,
  source: z.enum(["development", "release"]),
  target: runtimeTargetSchema,
}).meta({ ref: "OpenWorkServerV2RuntimeSummaryData" });

export const runtimeUpgradeDataSchema = z.object({
  state: runtimeUpgradeStateSchema,
  summary: runtimeSummaryDataSchema,
}).meta({ ref: "OpenWorkServerV2RuntimeUpgradeData" });

export const runtimeVersionsDataSchema = z.object({
  active: z.object({
    opencodeVersion: z.string().nullable(),
    routerVersion: z.string().nullable(),
    serverVersion: z.string(),
  }),
  manifest: runtimeManifestSchema.nullable(),
  pinned: z.object({
    opencodeVersion: z.string().nullable(),
    routerVersion: z.string().nullable(),
    serverVersion: z.string(),
  }),
  target: runtimeTargetSchema,
}).meta({ ref: "OpenWorkServerV2RuntimeVersionsData" });

export const opencodeHealthResponseSchema = successResponseSchema("OpenWorkServerV2OpencodeHealthResponse", opencodeHealthDataSchema);
export const routerHealthResponseSchema = successResponseSchema("OpenWorkServerV2RouterHealthResponse", routerHealthDataSchema);
export const runtimeSummaryResponseSchema = successResponseSchema("OpenWorkServerV2RuntimeSummaryResponse", runtimeSummaryDataSchema);
export const runtimeVersionsResponseSchema = successResponseSchema("OpenWorkServerV2RuntimeVersionsResponse", runtimeVersionsDataSchema);
export const runtimeUpgradeResponseSchema = successResponseSchema("OpenWorkServerV2RuntimeUpgradeResponse", runtimeUpgradeDataSchema);

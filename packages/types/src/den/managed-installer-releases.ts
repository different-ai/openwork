import { z } from "zod"

export const managedInstallerProviderSchema = z.enum(["aws", "gcp"])
export type ManagedInstallerProvider = z.infer<typeof managedInstallerProviderSchema>
export const managedInstallerApprovalModeSchema = z.enum(["platform_admin", "independent_admin"])
export type ManagedInstallerApprovalMode = z.infer<typeof managedInstallerApprovalModeSchema>
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const version = z.string().max(80).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
const httpsUrl = z.string().max(2048).url().refine(value => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === "https:" && !url.username && !url.password && !url.hash
}, "Use an HTTPS address without credentials or a fragment.")

export const managedInstallerCoordinatesSchema = z.object({
  version: z.string().max(80).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/), templateUrl: httpsUrl, bundleUrl: httpsUrl, bundleSha256: hash,
}).strict()
export type ManagedInstallerCoordinates = z.infer<typeof managedInstallerCoordinatesSchema>

export const managedInstallerQualificationSchema = z.object({
  freshInstallUrl: httpsUrl,
  approvedUpdateUrl: httpsUrl,
}).strict()
export type ManagedInstallerQualification = z.infer<typeof managedInstallerQualificationSchema>

export const managedInstallerHistorySchema = z.object({
  id: z.string(), provider: managedInstallerProviderSchema,
  action: z.enum(["source_saved", "approval_saved", "pinned", "reset"]),
  version: z.string().nullable(), actor: z.string(), createdAt: z.iso.datetime(),
  manifestSha256: hash.nullable(), qualification: managedInstallerQualificationSchema.nullable(),
})

export const managedInstallerProviderStateSchema = z.object({
  provider: managedInstallerProviderSchema,
  sourceBaseUrl: httpsUrl.nullable(),
  source: z.enum(["admin", "environment", "unconfigured", "invalid_configuration"]),
  release: managedInstallerCoordinatesSchema.nullable(),
  available: z.boolean(),
  revision: hash,
  updatedAt: z.iso.datetime().nullable(),
  approvalMode: managedInstallerApprovalModeSchema,
  pendingValidation: z.lazy(() => managedInstallerValidationSchema).nullable(),
})
export type ManagedInstallerProviderState = z.infer<typeof managedInstallerProviderStateSchema>
export const managedInstallerReportSchema = z.object({
  providers: z.array(managedInstallerProviderStateSchema),
  history: z.array(managedInstallerHistorySchema),
})
export type ManagedInstallerReport = z.infer<typeof managedInstallerReportSchema>

export const managedInstallerSourceInputSchema = z.object({
  sourceBaseUrl: httpsUrl,
  expectedRevision: hash,
}).strict()
export const managedInstallerApprovalInputSchema = z.object({
  approvalMode: managedInstallerApprovalModeSchema,
  expectedRevision: hash,
}).strict()
export const managedInstallerValidationInputSchema = z.object({
  provider: managedInstallerProviderSchema, version, expectedRevision: hash,
}).strict()
export const managedInstallerValidationSchema = z.object({
  id: z.string().uuid(), provider: managedInstallerProviderSchema,
  release: managedInstallerCoordinatesSchema,
  manifestSha256: hash,
  services: z.array(z.string()),
  verifiedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  verifiedBy: z.string(), canPin: z.boolean(),
})
export type ManagedInstallerValidation = z.infer<typeof managedInstallerValidationSchema>
export const managedInstallerPinInputSchema = z.object({
  provider: managedInstallerProviderSchema,
  validationId: z.string().uuid(), expectedRevision: hash,
  qualification: managedInstallerQualificationSchema,
}).strict()
export const managedInstallerResetInputSchema = z.object({
  provider: managedInstallerProviderSchema, expectedRevision: hash,
}).strict()
export const managedInstallerLatestSchema = z.object({ version, url: httpsUrl })
export const managedInstallerErrorSchema = z.object({ error: z.string(), message: z.string() })

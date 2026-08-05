import { z } from "zod"

import {
  micxAffordanceDescriptorSchema,
  micxProviderRefSchema,
} from "./micx-affordance.js"
import { micxFeatureContributionSchema } from "./micx-provider.js"

export const MICX_CONTEXT_SCHEMA_VERSION = 1

export const micxSessionRefSchema = z.object({
  workspaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  title: z.string().optional(),
})
export type MicxSessionRef = z.infer<typeof micxSessionRefSchema>

export const micxScreenSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    route: z.string(),
    workspaceId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("settings"),
    route: z.string(),
    workspaceId: z.string().optional(),
    panel: z.string(),
  }),
  z.object({
    kind: z.literal("other"),
    route: z.string(),
  }),
])
export type MicxScreen = z.infer<typeof micxScreenSchema>

export const micxConversationLayoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({
    kind: z.literal("single"),
    sessionId: z.string(),
  }),
  z.object({
    kind: z.literal("split"),
    primarySessionId: z.string(),
    secondarySessionId: z.string(),
    focused: z.enum(["primary", "secondary"]),
  }),
])
export type MicxConversationLayout = z.infer<typeof micxConversationLayoutSchema>

export const micxPanelTabSchema = z.object({
  id: z.string(),
  kind: z.enum(["browser", "artifact"]),
  label: z.string(),
  url: z.string().optional(),
  status: z.enum(["loading", "ready"]).optional(),
})
export type MicxPanelTab = z.infer<typeof micxPanelTabSchema>

export const micxResourceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  kind: z.enum(["workspace", "session", "screen", "side-panel", "settings"]),
  title: z.string(),
  provider: micxProviderRefSchema,
  state: z.record(z.string(), z.unknown()),
})
export type MicxResourceDescriptor = z.infer<typeof micxResourceDescriptorSchema>

export const micxContextSnapshotSchema = z.object({
  schemaVersion: z.literal(MICX_CONTEXT_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  capturedAt: z.string(),
  screen: micxScreenSchema,
  conversations: z.object({
    tabs: z.array(micxSessionRefSchema),
    layout: micxConversationLayoutSchema,
  }),
  chrome: z.object({
    sidebarOpen: z.boolean(),
    applicationMenuVisible: z.boolean(),
    rightSidebarExpanded: z.boolean(),
  }),
  execution: z.object({
    queries: z.literal("parallel"),
    commands: z.literal("serialized"),
    busyCommandId: z.string().nullable(),
    busyActor: z.string().nullable(),
  }),
  sidePanel: z.object({
    open: z.boolean(),
    ownerSessionId: z.string().nullable(),
    kind: z.enum(["panel", "extensions", "voice"]).nullable(),
    tabs: z.array(micxPanelTabSchema),
    activeTabId: z.string().nullable(),
  }),
  resources: z.array(micxResourceDescriptorSchema),
  availableAffordances: z.array(micxAffordanceDescriptorSchema),
  contributions: z.array(micxFeatureContributionSchema),
})
export type MicxContextSnapshot = z.infer<typeof micxContextSnapshotSchema>

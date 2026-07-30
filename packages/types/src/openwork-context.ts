import { z } from "zod"

import {
  openworkAffordanceDescriptorSchema,
  openworkProviderRefSchema,
} from "./openwork-affordance.js"
import { openworkFeatureContributionSchema } from "./openwork-provider.js"

export const OPENWORK_CONTEXT_SCHEMA_VERSION = 1

export const openworkSessionRefSchema = z.object({
  workspaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  title: z.string().optional(),
})
export type OpenworkSessionRef = z.infer<typeof openworkSessionRefSchema>

export const openworkScreenSchema = z.discriminatedUnion("kind", [
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
export type OpenworkScreen = z.infer<typeof openworkScreenSchema>

export const openworkConversationLayoutSchema = z.discriminatedUnion("kind", [
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
export type OpenworkConversationLayout = z.infer<typeof openworkConversationLayoutSchema>

export const openworkPanelTabSchema = z.object({
  id: z.string(),
  kind: z.enum(["browser", "artifact"]),
  label: z.string(),
  url: z.string().optional(),
  status: z.enum(["loading", "ready"]).optional(),
})
export type OpenworkPanelTab = z.infer<typeof openworkPanelTabSchema>

export const openworkResourceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  kind: z.enum(["workspace", "session", "screen", "side-panel", "settings"]),
  title: z.string(),
  provider: openworkProviderRefSchema,
  state: z.record(z.string(), z.unknown()),
})
export type OpenworkResourceDescriptor = z.infer<typeof openworkResourceDescriptorSchema>

export const openworkContextSnapshotSchema = z.object({
  schemaVersion: z.literal(OPENWORK_CONTEXT_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  capturedAt: z.string(),
  screen: openworkScreenSchema,
  conversations: z.object({
    tabs: z.array(openworkSessionRefSchema),
    layout: openworkConversationLayoutSchema,
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
    tabs: z.array(openworkPanelTabSchema),
    activeTabId: z.string().nullable(),
  }),
  resources: z.array(openworkResourceDescriptorSchema),
  availableAffordances: z.array(openworkAffordanceDescriptorSchema),
  contributions: z.array(openworkFeatureContributionSchema),
})
export type OpenworkContextSnapshot = z.infer<typeof openworkContextSnapshotSchema>

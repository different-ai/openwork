import type { FeatureKey } from "@openwork/features"
import type { Microsoft365Feature } from "@openwork/types/den/microsoft-365"
import { z } from "zod"
import { graphItemIdSchema } from "./microsoft-365-shared.js"

export const MICROSOFT_GRAPH_RESOURCE_PREFIX = "/v1/capabilities/microsoft-365"

type Field = Readonly<{ from: string; type: "string" | "number" | "boolean" | "emailAddress" }>
type Filter =
  | Readonly<{ schema: z.ZodType<"true" | "false" | undefined>; effect: "whenTrue"; clause: string }>
  | Readonly<{ schema: z.ZodType<string>; effect: "quotedSearch"; property: string }>

type Paging = Readonly<{ max: number; default: number }>

export type MicrosoftGraphResource = Readonly<{
  operationId: string
  route: `/${string}`
  summary: string
  description: string
  flag: FeatureKey
  permission: "connection" | Readonly<{ features: readonly [Microsoft365Feature, ...Microsoft365Feature[]]; label: string }>
  graph: Readonly<{
    path: string
    headers?: Readonly<Record<string, string>>
    select: boolean
    top?: Paging
    orderBy?: string
    count?: true
  }>
  fields: Readonly<Record<string, Field>>
  params: Readonly<Record<string, typeof graphItemIdSchema>>
  filters: Readonly<Record<string, Filter>>
  output: Readonly<{ kind: "list" | "item"; key: string }>
  audit: Readonly<{ action: string; resource: string; carriesContent: boolean; idParam?: string }>
}>

const flag = "microsoft365ReadResources"
const mailRead: MicrosoftGraphResource["permission"] = { features: ["mailRead"], label: "Outlook mail read" }
const teamsChannelList: MicrosoftGraphResource["permission"] = { features: ["teamsChannelList"], label: "Teams and channels" }
const folderPage = { max: 50, default: 25 }
const smallPage = { max: 25, default: 10 }
const folderFields: MicrosoftGraphResource["fields"] = {
  id: { from: "id", type: "string" },
  name: { from: "displayName", type: "string" },
  parentFolderId: { from: "parentFolderId", type: "string" },
  childFolderCount: { from: "childFolderCount", type: "number" },
  unreadItemCount: { from: "unreadItemCount", type: "number" },
  totalItemCount: { from: "totalItemCount", type: "number" },
}
const userFields: MicrosoftGraphResource["fields"] = {
  id: { from: "id", type: "string" },
  displayName: { from: "displayName", type: "string" },
  givenName: { from: "givenName", type: "string" },
  surname: { from: "surname", type: "string" },
  mail: { from: "mail", type: "string" },
  userPrincipalName: { from: "userPrincipalName", type: "string" },
}
const teamFields: MicrosoftGraphResource["fields"] = {
  id: { from: "id", type: "string" },
  displayName: { from: "displayName", type: "string" },
  description: { from: "description", type: "string" },
}

export const microsoftGraphResources: readonly MicrosoftGraphResource[] = [
  {
    operationId: "listMicrosoft365MailFolders",
    route: "/mail-folders",
    summary: "List Outlook mail folders",
    description: "Lists the connected member's top-level mail folders with message and child folder counts. Hidden folders are not returned.",
    flag, permission: mailRead,
    graph: { path: "me/mailFolders", select: true, top: folderPage },
    fields: folderFields, params: {}, filters: {},
    output: { kind: "list", key: "folders" },
    audit: { action: "capability.outlook_mail.folder.list", resource: "outlook_folder", carriesContent: true },
  },
  {
    operationId: "listMicrosoft365MailFolderChildren",
    route: "/mail-folders/:folderId/children",
    summary: "List child folders of an Outlook mail folder",
    description: "Lists the immediate non-hidden child folders of a mail folder, with message and child folder counts.",
    flag, permission: mailRead,
    graph: { path: "me/mailFolders/{folderId}/childFolders", select: true, top: folderPage },
    fields: folderFields,
    params: { folderId: graphItemIdSchema.describe("Folder ID from the Outlook mail folders list.") }, filters: {},
    output: { kind: "list", key: "folders" },
    audit: { action: "capability.outlook_mail.folder.children.list", resource: "outlook_folder", idParam: "folderId", carriesContent: true },
  },
  {
    operationId: "listMicrosoft365MailFolderMessages",
    route: "/mail-folders/:folderId/messages",
    summary: "List messages in an Outlook mail folder",
    description: "Lists message summaries, newest first, from a single folder. Can return only unread messages; does not load full message bodies.",
    flag, permission: mailRead,
    graph: { path: "me/mailFolders/{folderId}/messages", select: true, top: smallPage, orderBy: "receivedDateTime desc" },
    fields: {
      id: { from: "id", type: "string" },
      conversationId: { from: "conversationId", type: "string" },
      subject: { from: "subject", type: "string" },
      receivedDateTime: { from: "receivedDateTime", type: "string" },
      preview: { from: "bodyPreview", type: "string" },
      from: { from: "from", type: "emailAddress" },
      isRead: { from: "isRead", type: "boolean" },
      hasAttachments: { from: "hasAttachments", type: "boolean" },
      webLink: { from: "webLink", type: "string" },
    },
    params: { folderId: graphItemIdSchema.describe("Folder ID or a well-known folder name: inbox, drafts, sentitems, deleteditems, archive or junkemail.") },
    filters: {
      unreadOnly: {
        schema: z.enum(["true", "false"]).optional().describe("Set to true to return only unread messages."),
        effect: "whenTrue",
        clause: "receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false",
      },
    },
    output: { kind: "list", key: "messages" },
    audit: { action: "capability.outlook_mail.folder.messages.list", resource: "outlook_folder", idParam: "folderId", carriesContent: true },
  },
  {
    operationId: "getMicrosoft365Profile",
    route: "/profile",
    summary: "Read the connected member's Microsoft 365 profile",
    description: "Returns the member's own name, email, sign-in address, job title and office location when available.",
    flag, permission: "connection",
    graph: { path: "me", select: true },
    fields: { ...userFields, jobTitle: { from: "jobTitle", type: "string" }, officeLocation: { from: "officeLocation", type: "string" } },
    params: {}, filters: {},
    output: { kind: "item", key: "profile" },
    audit: { action: "capability.microsoft_365.profile.read", resource: "microsoft_365_profile", carriesContent: true },
  },
  {
    operationId: "searchMicrosoft365People",
    route: "/people",
    summary: "Find people in the Microsoft 365 directory by name",
    description: "Searches the organization's directory by display name and returns basic profiles with names, email and sign-in addresses.",
    flag, permission: { features: ["directoryRead"], label: "Directory read" },
    graph: { path: "users", select: true, top: smallPage, count: true, orderBy: "displayName", headers: { ConsistencyLevel: "eventual" } },
    fields: userFields, params: {},
    filters: { name: { schema: z.string().min(1).max(100).describe("Name to search for."), effect: "quotedSearch", property: "displayName" } },
    output: { kind: "list", key: "people" },
    audit: { action: "capability.microsoft_365.people.search", resource: "microsoft_365_profile", carriesContent: true },
  },
  {
    operationId: "listMicrosoft365JoinedTeams",
    route: "/teams",
    summary: "List the connected member's Teams teams",
    description: "Lists the teams the member has joined, with IDs, names and descriptions. Does not read chats or messages.",
    flag, permission: teamsChannelList,
    graph: { path: "me/joinedTeams", select: false },
    fields: teamFields, params: {}, filters: {},
    output: { kind: "list", key: "teams" },
    audit: { action: "capability.teams.team.list", resource: "teams_team", carriesContent: true },
  },
  {
    operationId: "listMicrosoft365TeamChannels",
    route: "/teams/:teamId/channels",
    summary: "List channels in a Teams team",
    description: "Lists the channels the member can see in a team, with names, descriptions, membership types and links. Does not read channel messages.",
    flag, permission: teamsChannelList,
    graph: { path: "teams/{teamId}/channels", select: true },
    fields: { ...teamFields, membershipType: { from: "membershipType", type: "string" }, webUrl: { from: "webUrl", type: "string" } },
    params: { teamId: graphItemIdSchema.describe("Team ID from the joined teams list.") }, filters: {},
    output: { kind: "list", key: "channels" },
    audit: { action: "capability.teams.channel.list", resource: "teams_team", idParam: "teamId", carriesContent: true },
  },
]

import type { ConnectSnapshot } from "../connect-contract.js";
import type {
  ExtensionActionContribution,
  ExtensionActionDescriptor,
  ExtensionActionInvocation,
} from "./action-contract.js";

export const GOOGLE_WORKSPACE_EXTENSION_ID = "google-workspace";

export const GOOGLE_WORKSPACE_EXTENSION_ACTIONS: readonly ExtensionActionDescriptor[] = [
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "status",
    title: "Google Workspace status",
    description: "Check whether Google Workspace is connected and ready for OpenWork extension actions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "calendar_list_events",
    title: "List calendar events",
    description: "List events from the connected Google Calendar account for a requested time range.",
    inputSchema: {
      type: "object",
      properties: {
        timeMin: { type: "string", description: "Inclusive ISO datetime lower bound." },
        timeMax: { type: "string", description: "Exclusive ISO datetime upper bound." },
        maxResults: { type: "number", description: "Maximum events to return." },
      },
      required: ["timeMin", "timeMax"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "gmail_create_draft",
    title: "Create Gmail draft",
    description: "Create a Gmail draft for the connected account. This does not send email.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses." },
        cc: { type: "array", items: { type: "string" }, description: "Optional CC recipients." },
        bcc: { type: "array", items: { type: "string" }, description: "Optional BCC recipients." },
        subject: { type: "string", description: "Draft subject." },
        body: { type: "string", description: "Plain text draft body." },
        attachments: {
          type: "array",
          description: "Optional local files to attach. Paths may be relative to the active workspace/directory or absolute under an authorized workspace root.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative path or authorized absolute file path." },
              filename: { type: "string", description: "Optional attachment filename shown in Gmail." },
              mimeType: { type: "string", description: "Optional attachment MIME type. Defaults from the file extension when possible." },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "gmail_create_reply_draft",
    title: "Create Gmail reply draft",
    description: "Create a Gmail draft reply in an existing thread. This does not send email. Requires Gmail read access (gmail.readonly scope).",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Gmail message id to reply to." },
        body: { type: "string", description: "Plain text reply body." },
        replyAll: { type: "boolean", description: "Reply to everyone on the original message. Defaults to true." },
      },
      required: ["messageId", "body"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "gmail_list_messages",
    title: "List Gmail messages",
    description: "List recent Gmail messages for the connected account. Requires Gmail read access (gmail.readonly scope).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional Gmail search query, e.g. 'is:unread' or 'from:someone@example.com'." },
        maxResults: { type: "number", description: "Maximum messages to return." },
      },
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "gmail_get_message",
    title: "Read Gmail message",
    description: "Read a Gmail message by id, including its plain text body and attachment metadata. Requires Gmail read access (gmail.readonly scope).",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Gmail message id." },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "gmail_download_attachment",
    title: "Download Gmail attachment",
    description: "Download a Gmail attachment by message id and attachment id. Returns base64-encoded attachment bytes. Requires Gmail read access (gmail.readonly scope).",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Gmail message id." },
        attachmentId: { type: "string", description: "Gmail attachment id from gmail_get_message attachment metadata." },
      },
      required: ["messageId", "attachmentId"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "drive_search_files",
    title: "Search Drive files",
    description: "Search files available to OpenWork through the connected Google Drive scope. With full Drive access enabled, this searches the entire Drive.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text." },
        maxResults: { type: "number", description: "Maximum files to return." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "drive_read_file",
    title: "Read Drive file",
    description: "Read a Drive file available to OpenWork by file id.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file id." },
      },
      required: ["fileId"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "drive_update_file",
    title: "Update Drive file",
    description: "Replace the plain text content of a Drive file available to OpenWork by file id.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file id." },
        content: { type: "string", description: "New plain text content for the file." },
      },
      required: ["fileId", "content"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "calendar_create_event",
    title: "Create calendar event",
    description: "Create an event on the connected Google Calendar. Requires calendar editing access (calendar.events scope).",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title." },
        description: { type: "string", description: "Optional event description." },
        location: { type: "string", description: "Optional event location." },
        start: { type: "string", description: "Event start as ISO datetime." },
        end: { type: "string", description: "Event end as ISO datetime." },
        timeZone: { type: "string", description: "Optional IANA time zone, e.g. 'Europe/Paris'." },
        attendees: { type: "array", items: { type: "string" }, description: "Optional attendee email addresses." },
      },
      required: ["summary", "start", "end"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "chat_list_spaces",
    title: "List Google Chat spaces",
    description: "List Google Chat spaces for the connected account. Requires Google Chat access.",
    inputSchema: {
      type: "object",
      properties: {
        maxResults: { type: "number", description: "Maximum spaces to return." },
      },
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "chat_list_messages",
    title: "List Google Chat messages",
    description: "List recent messages in a Google Chat space. Requires Google Chat access.",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: { type: "string", description: "Chat space id or resource name, e.g. 'spaces/AAAA1234'." },
        maxResults: { type: "number", description: "Maximum messages to return." },
      },
      required: ["spaceId"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "chat_send_message",
    title: "Send Google Chat message",
    description: "Send a text message to a Google Chat space. Requires Google Chat access.",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: { type: "string", description: "Chat space id or resource name, e.g. 'spaces/AAAA1234'." },
        text: { type: "string", description: "Message text." },
      },
      required: ["spaceId", "text"],
      additionalProperties: false,
    },
  },
];

export type GoogleWorkspaceActionOperations = {
  readonly status: (extra: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly calendarListEvents: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly gmailCreateDraft: (args: Readonly<Record<string, unknown>>, clientContext: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly gmailCreateReplyDraft: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly gmailListMessages: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly gmailGetMessage: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly gmailDownloadAttachment: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly driveSearchFiles: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly driveReadFile: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly driveUpdateFile: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly calendarCreateEvent: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly chatListSpaces: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly chatListMessages: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly chatSendMessage: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
};

export type GoogleWorkspaceConnectPolicy = {
  readonly isGated: (snapshot: ConnectSnapshot) => boolean;
  readonly guidance: (snapshot: ConnectSnapshot) => string;
  readonly statusExtra: (snapshot: ConnectSnapshot) => Record<string, unknown>;
};

type GoogleActionOperation = (invocation: ExtensionActionInvocation) => Promise<unknown>;

function successfulResult(
  descriptor: ExtensionActionDescriptor,
  invocation: ExtensionActionInvocation,
  result: unknown,
): Record<string, unknown> {
  return {
    ok: true,
    extensionId: descriptor.extensionId,
    action: descriptor.action,
    result,
    context: invocation.clientContext,
  };
}

function createGoogleAction(
  descriptor: ExtensionActionDescriptor,
  operation: GoogleActionOperation,
  policy: GoogleWorkspaceConnectPolicy,
): ExtensionActionContribution {
  return {
    descriptor,
    isListed: ({ connectSnapshot }) => !connectSnapshot || !policy.isGated(connectSnapshot),
    execute: async (invocation) => {
      const snapshot = invocation.hostContext.connectSnapshot;
      if (snapshot && policy.isGated(snapshot)) {
        return {
          ok: false,
          error: "use_openwork_cloud",
          message: policy.guidance(snapshot),
        };
      }
      return successfulResult(descriptor, invocation, await operation(invocation));
    },
  };
}

export function createGoogleWorkspaceActionContributions(
  operations: GoogleWorkspaceActionOperations,
  policy: GoogleWorkspaceConnectPolicy,
): readonly ExtensionActionContribution[] {
  const status = GOOGLE_WORKSPACE_EXTENSION_ACTIONS[0];
  return [
    {
      descriptor: status,
      execute: async (invocation) => {
        const snapshot = invocation.hostContext.connectSnapshot;
        const extra = snapshot ? policy.statusExtra(snapshot) : {};
        return successfulResult(status, invocation, await operations.status(extra));
      },
    },
    createGoogleAction(GOOGLE_WORKSPACE_EXTENSION_ACTIONS[1], ({ args }) => operations.calendarListEvents(args), policy),
    createGoogleAction(GOOGLE_WORKSPACE_EXTENSION_ACTIONS[2], ({ args, clientContext }) => operations.gmailCreateDraft(args, clientContext), policy),
    createGoogleAction(GOOGLE_WORKSPACE_EXTENSION_ACTIONS[3], ({ args }) => operations.gmailCreateReplyDraft(args), policy),
    createGoogleAction(GOOGLE_WORKSPACE_EXTENSION_ACTIONS[4], ({ args }) => operations.gmailListMessages(args), policy),
    createGoogleAction(GOOGLE_WORKSPACE_EXTENSION_ACTIONS[5], ({ args }) => operations.gmailGetMessage(args), policy),
    createGoogleAction(GOOGLE_WORKSPACE_EXTENSION_ACTIONS[6], ({ args }) => operations.gmailDownloadAttachment(args), policy),
    createGoogleAction(GOOGLE_WORKSPACE_EXTENSION_ACTIONS[7], ({ args }) => operations.driveSearchFiles(args), policy),
    createGoogleAction(GOOGLE_WORKSPACE_EXTENSION_ACTIONS[8], ({ args }) => operations.driveReadFile(args), policy),
    createGoogleAction(GOOGLE_WORKSPACE_EXTENSION_ACTIONS[9], ({ args }) => operations.driveUpdateFile(args), policy),
    createGoogleAction(GOOGLE_WORKSPACE_EXTENSION_ACTIONS[10], ({ args }) => operations.calendarCreateEvent(args), policy),
    createGoogleAction(GOOGLE_WORKSPACE_EXTENSION_ACTIONS[11], ({ args }) => operations.chatListSpaces(args), policy),
    createGoogleAction(GOOGLE_WORKSPACE_EXTENSION_ACTIONS[12], ({ args }) => operations.chatListMessages(args), policy),
    createGoogleAction(GOOGLE_WORKSPACE_EXTENSION_ACTIONS[13], ({ args }) => operations.chatSendMessage(args), policy),
  ];
}

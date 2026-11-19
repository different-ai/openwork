/** Shared with the v2 bridge without importing the host's storage dependencies. */
export const OPENWORK_CLOUD_UPLOADS_EXTENSION_ID = "openwork-cloud-uploads";
/** The v2 engine permission a person answers before an agent's Drive upload runs. */
export const DRIVE_UPLOAD_PERMISSION = "drive_upload_file";
/** The v2 engine permission a person answers before a Gmail draft with workspace attachments is created. */
export const GMAIL_DRAFT_PERMISSION = "gmail_create_draft_with_attachments";
/** The v2 engine permission a person answers before an Outlook draft with workspace attachments is created. */
export const OUTLOOK_DRAFT_PERMISSION = "outlook_create_draft_with_attachments";
/** Microsoft Graph attaches a file in one request only below 3 MB. */
export const OUTLOOK_ATTACHMENT_MAX_BYTES = 3_000_000;

import { UTApi } from "uploadthing/server";

export const APP_FEEDBACK_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
export const APP_FEEDBACK_ATTACHMENT_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type FeedbackAttachment = {
  name: string;
  fileKey: string;
  accessUrl: string;
  size: number;
  contentType: string;
};

export function getUploadThingToken(): string {
  return String(process.env.UPLOADTHING_TOKEN ?? "").trim();
}

export function createUploadThingApi(token: string): UTApi {
  return new UTApi({ token });
}

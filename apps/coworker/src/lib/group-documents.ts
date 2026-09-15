import type { CoworkerDocument } from "./documents";

export type GroupDocument = CoworkerDocument & { groupId: string; author: string; authorSlug: string };
export type GroupDocumentSummary = Omit<GroupDocument, "body"> & { words: number };
export type GroupDocumentSave = { title: string; body: string; summary?: string; highlights?: string[] }
  & ({ id: string; expectedRevision: number } | { id?: never; expectedRevision?: never });
export type GroupDocumentSaved = GroupDocument & { changed: boolean; announcementFailed?: true };

export type GroupDocumentsApi = {
  list: (groupId: string) => Promise<GroupDocumentSummary[]>;
  read: (groupId: string, id: string) => Promise<GroupDocument>;
  save: (groupId: string, input: GroupDocumentSave) => Promise<GroupDocumentSaved>;
  revisions: (groupId: string, id: string) => Promise<GroupDocument[]>;
  restore: (groupId: string, id: string, revision: number, expectedRevision: number) => Promise<GroupDocumentSaved>;
};

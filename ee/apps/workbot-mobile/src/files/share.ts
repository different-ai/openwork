import { inChat, type WorkbotAttachment } from "@openwork-ee/workbot-client"
import * as Sharing from "expo-sharing"
import { Alert } from "react-native"
import { cachedFile } from "./cache"

type Signed = { url(path: string): string; authHeaders(): Promise<Record<string, string>> }

/** A kept file on this phone, downloaded once per version. */
export async function localCopy(session: Signed, file: Pick<WorkbotAttachment, "id" | "name" | "updatedAt">, chat: string | null) {
  return cachedFile({ url: session.url(inChat(`/v1/workbot/files/${file.id}`, chat)), headers: await session.authHeaders(), id: file.id, name: file.name, version: file.updatedAt })
}

/** Save or send a kept file through the system's share sheet (Save to Files, AirDrop, another app). */
export async function shareFile(session: Signed, file: Pick<WorkbotAttachment, "id" | "name" | "mediaType" | "updatedAt">, chat: string | null) {
  try {
    const local = await localCopy(session, file, chat)
    await Sharing.shareAsync(local.uri, { mimeType: file.mediaType, dialogTitle: file.name })
  } catch {
    Alert.alert("This file is no longer available.")
  }
}

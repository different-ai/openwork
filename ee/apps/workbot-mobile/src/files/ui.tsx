import { badgeFor, inChat, isImage, kindLabel, type WorkbotAttachment } from "@openwork-ee/workbot-client"
import { useWorkbotChat } from "@openwork-ee/workbot-client/hooks"
import { Image, type ImageSource } from "expo-image"
import { useEffect, useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { useSession } from "../auth/session"
import { color, shadow, toneColor } from "../theme"

/** A kept image as an image source: signed in, cached by file and version. */
export function useKeptImage(id: string | null, version?: number): ImageSource | null {
  const session = useSession()
  const chat = useWorkbotChat()
  const [headers, setHeaders] = useState<Record<string, string> | null>(null)
  useEffect(() => {
    let cancelled = false
    void session.authHeaders().then((value) => !cancelled && setHeaders(value))
    return () => {
      cancelled = true
    }
  }, [session])
  if (!id || !headers) return null
  return { uri: session.url(inChat(`/v1/workbot/files/${id}?inline=1`, chat)), headers, cacheKey: `workbot-${chat ?? "main"}-${id}-${version ?? 0}` }
}

/** A file type's badge: its short label in its color (PDF red, Word blue, …). */
export function FileBadge({ name, mediaType, size = 36 }: { name: string; mediaType: string; size?: number }) {
  const badge = badgeFor(name, mediaType)
  return (
    <View style={[styles.badge, { width: size, height: size }]}>
      <Text style={[styles.badgeText, { color: toneColor[badge.tone] }]}>{badge.label}</Text>
    </View>
  )
}

/** A small square thumbnail of a kept image, or of one still on this phone. */
export function ImageThumb({ id, version, localUri, size = 36 }: { id: string | null; version?: number; localUri?: string | null; size?: number }) {
  const kept = useKeptImage(localUri ? null : id, version)
  const source = localUri ? { uri: localUri } : kept
  return <Image source={source} style={[styles.thumb, { width: size, height: size }]} contentFit="cover" transition={120} accessibilityIgnoresInvertColors />
}

/** A file card: thumbnail or badge, name, and what kind it is. */
export function FileCard({ file, onPress, localUri }: { file: WorkbotAttachment; onPress?: () => void; localUri?: string | null }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${file.name}`} disabled={!onPress} onPress={onPress} style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}>
      {isImage(file.mediaType) ? <ImageThumb id={file.id} version={file.updatedAt} localUri={localUri} /> : <FileBadge name={file.name} mediaType={file.mediaType} />}
      <View style={styles.cardText}>
        <Text numberOfLines={1} style={styles.cardName}>{file.name}</Text>
        <Text style={styles.cardKind}>{kindLabel(file.name, file.mediaType)}</Text>
      </View>
    </Pressable>
  )
}

/** Files sent with a message, right-aligned above its bubble: images as pictures, other files as cards. */
export function SentAttachments({ attachments, localUris, onOpen }: { attachments: WorkbotAttachment[]; localUris?: Record<string, string | null>; onOpen: (file: WorkbotAttachment) => void }) {
  if (attachments.length === 0) return null
  return (
    <View style={styles.sent}>
      {attachments.map((file) =>
        isImage(file.mediaType) ? (
          <Pressable key={file.id} accessibilityRole="imagebutton" accessibilityLabel={`Open ${file.name}`} onPress={() => onOpen(file)}>
            <ImageThumb id={file.id.startsWith("local-") ? null : file.id} version={file.updatedAt} localUri={localUris?.[file.id] ?? null} size={120} />
          </Pressable>
        ) : (
          <FileCard key={file.id} file={file} onPress={file.id.startsWith("local-") ? undefined : () => onOpen(file)} />
        ),
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  badge: { borderRadius: 8, backgroundColor: color.chip, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.3 },
  thumb: { borderRadius: 8, backgroundColor: color.chip },
  card: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, paddingLeft: 8, paddingRight: 16, borderRadius: 14, backgroundColor: color.surface, boxShadow: shadow.card, maxWidth: 320, alignSelf: "flex-start" },
  pressed: { opacity: 0.8 },
  cardText: { flexShrink: 1, gap: 1 },
  cardName: { fontSize: 13.5, fontWeight: "500", lineHeight: 20, color: color.text },
  cardKind: { fontSize: 12, lineHeight: 16, color: color.muted },
  sent: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6, paddingBottom: 4 },
})

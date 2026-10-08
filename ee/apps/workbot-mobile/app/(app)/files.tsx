import { CHAT_ID, dayLabel, formatSize, isImage, type WorkbotFile } from "@openwork-ee/workbot-client"
import { useDeleteWorkbotFile, useWorkbotChat, useWorkbotFiles, WorkbotChatProvider } from "@openwork-ee/workbot-client/hooks"
import { useLocalSearchParams } from "expo-router"
import { Share2, Trash2 } from "lucide-react-native"
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native"
import { openFile } from "../../src/chat/screen"
import { shareFile } from "../../src/files/share"
import { FileBadge, ImageThumb } from "../../src/files/ui"
import { useSession } from "../../src/auth/session"
import { IconButton, QuietButton } from "../../src/ui/controls"
import { color } from "../../src/theme"

function FileRow({ file, assistantName }: { file: WorkbotFile; assistantName: string }) {
  const remove = useDeleteWorkbotFile()
  const chat = useWorkbotChat()
  const session = useSession()
  return (
    <View style={styles.row}>
      {isImage(file.mediaType) ? <ImageThumb id={file.id} version={file.updatedAt} size={36} /> : <FileBadge name={file.name} mediaType={file.mediaType} />}
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${file.name}`} onPress={() => openFile(file, chat)} style={styles.rowText}>
        <Text numberOfLines={1} style={styles.name}>{file.name}</Text>
        <Text numberOfLines={1} style={styles.meta}>
          {file.source === "agent" ? `Made by ${assistantName} · ` : ""}{dayLabel(file.createdAt)} · {formatSize(file.size)}
        </Text>
      </Pressable>
      <IconButton label={`Delete ${file.name}`} disabled={remove.isPending} onPress={() => remove.mutate(file.id)}>
        <Trash2 size={16} strokeWidth={1.75} color={color.muted} />
      </IconButton>
      <IconButton label={`Share ${file.name}`} onPress={() => void shareFile(session, file, chat)}>
        <Share2 size={16} strokeWidth={1.75} color={color.muted} />
      </IconButton>
    </View>
  )
}

function FilesList({ assistantName }: { assistantName: string }) {
  const files = useWorkbotFiles(true)
  const list = files.data?.files ?? []
  const total = list.reduce((sum, file) => sum + file.size, 0)
  return (
    <View style={styles.sheet}>
      <Text accessibilityRole="header" style={styles.heading}>Files</Text>
      {files.isPending ? (
        <View style={styles.loading}>{[0, 1, 2].map((index) => <View key={index} style={styles.placeholder} />)}</View>
      ) : files.isError ? (
        <View style={styles.note}>
          <Text style={styles.noteText}>Couldn't load your files.</Text>
          <QuietButton label="Try again" onPress={() => void files.refetch()} />
        </View>
      ) : list.length === 0 ? (
        <Text style={[styles.noteText, styles.note]}>Files you send {assistantName}, and files it makes for you, are kept here.</Text>
      ) : (
        <FlatList data={list} keyExtractor={(file) => file.id} renderItem={({ item }) => <FileRow file={item} assistantName={assistantName} />} />
      )}
      {list.length > 0 ? (
        <View style={styles.footer}>
          <Text style={styles.footerText}>{list.length} {list.length === 1 ? "file" : "files"} · {formatSize(total)}</Text>
          <Text style={styles.footerText}>Kept until you delete them</Text>
        </View>
      ) : null}
    </View>
  )
}

/** Everything kept in a chat, newest first: open, share or delete. */
export default function Files() {
  const params = useLocalSearchParams<{ chat?: string; name?: string }>()
  const chat = typeof params.chat === "string" && CHAT_ID.test(params.chat) ? params.chat : null
  return (
    <WorkbotChatProvider value={chat}>
      <FilesList assistantName={typeof params.name === "string" && params.name ? params.name : "Workbot"} />
    </WorkbotChatProvider>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: color.surface, paddingTop: 20 },
  heading: { paddingHorizontal: 20, paddingBottom: 8, fontSize: 15, fontWeight: "600", color: color.text },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 16 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontSize: 14, fontWeight: "500", color: color.text },
  meta: { fontSize: 12, color: color.muted },
  loading: { gap: 18, paddingHorizontal: 20, paddingTop: 12 },
  placeholder: { width: 180, height: 12, borderRadius: 4, backgroundColor: color.chip },
  note: { paddingHorizontal: 20, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  noteText: { fontSize: 13, lineHeight: 20, color: color.muted },
  footer: { height: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  footerText: { fontSize: 12, color: color.muted },
})

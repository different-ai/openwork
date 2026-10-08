import { formatSize } from "@openwork-ee/workbot-client"
import * as DocumentPicker from "expo-document-picker"
import * as ImagePicker from "expo-image-picker"
import { ArrowUp, Lock, Paperclip, RotateCw, X } from "lucide-react-native"
import { useState } from "react"
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { ImageThumb, FileBadge } from "../files/ui"
import type { LocalFile, Upload } from "../files/uploads"
import { IconButton } from "../ui/controls"
import { color, shadow } from "../theme"

/** Photos, Camera or Files: what the paperclip offers on a phone. */
async function pickFiles(source: "photos" | "camera" | "files"): Promise<LocalFile[]> {
  if (source === "files") {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (result.canceled) return []
    return result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? "application/octet-stream", size: asset.size ?? 0 }))
  }
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted) {
      Alert.alert("Camera is off for Workbot", "Turn it on in Settings to take a photo.")
      return []
    }
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.9, allowsMultipleSelection: source === "photos", selectionLimit: 10 }
  const result = source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options)
  if (result.canceled) return []
  return result.assets.map((asset, index) => ({
    uri: asset.uri,
    name: asset.fileName ?? `Photo ${index + 1}.${(asset.mimeType ?? "image/jpeg").split("/")[1] ?? "jpg"}`,
    mimeType: asset.mimeType ?? "image/jpeg",
    size: asset.fileSize ?? 0,
  }))
}

function chooseSource(onPick: (source: "photos" | "camera" | "files") => void) {
  const options = ["Photos", "Camera", "Files", "Cancel"] as const
  const sources = ["photos", "camera", "files"] as const
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions({ options: [...options], cancelButtonIndex: 3 }, (index) => {
      const source = sources[index]
      if (source) onPick(source)
    })
    return
  }
  Alert.alert("Add to your message", undefined, [
    { text: "Photos", onPress: () => onPick("photos") },
    { text: "Camera", onPress: () => onPick("camera") },
    { text: "Files", onPress: () => onPick("files") },
    { text: "Cancel", style: "cancel" },
  ])
}

/** The paperclip: adds files, or, when this server keeps no files, says so and who can change it. */
function AttachButton({ enabled, onFiles }: { enabled: boolean; onFiles: (files: LocalFile[]) => void }) {
  if (!enabled) {
    return (
      <IconButton
        label="Attach files. Files aren't set up on this server; your admin can turn them on."
        onPress={() => Alert.alert("Files aren't set up on this server.", "Your admin can turn them on.")}
        style={styles.lockedClip}
      >
        <Paperclip size={18} strokeWidth={1.75} color={color.disabled} />
        <View style={styles.lockBadge}><Lock size={8} strokeWidth={2.5} color={color.surface} /></View>
      </IconButton>
    )
  }
  return (
    <IconButton label="Attach files" onPress={() => chooseSource((source) => void pickFiles(source).then((files) => files.length && onFiles(files)))}>
      <Paperclip size={18} strokeWidth={1.75} color={color.muted} />
    </IconButton>
  )
}

function ProgressBar({ value }: { value: number }) {
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }]} />
    </View>
  )
}

/** The files waiting in the composer, each with its progress, and remove or try again. */
function UploadTray({ uploads, onRemove, onRetry }: { uploads: Upload[]; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  return (
    <View style={styles.tray}>
      {uploads.map((upload) => (
        <View key={upload.key} style={styles.trayItem}>
          {upload.previewUri ? <ImageThumb id={null} localUri={upload.previewUri} size={32} /> : <FileBadge name={upload.file.name} mediaType={upload.file.mimeType} size={32} />}
          <View style={styles.trayText}>
            <Text numberOfLines={1} style={styles.trayName}>{upload.file.name}</Text>
            {upload.status === "failed" ? (
              <Text numberOfLines={1} style={styles.trayFailed}>{upload.error ?? "Couldn't upload."}</Text>
            ) : upload.status === "uploading" ? (
              <ProgressBar value={upload.file.size ? upload.loaded / upload.file.size : 0} />
            ) : (
              <Text style={styles.trayMeta}>{formatSize(upload.file.size)}</Text>
            )}
          </View>
          {upload.status === "failed" ? (
            <IconButton label={`Try uploading ${upload.file.name} again`} onPress={() => onRetry(upload.key)} style={styles.trayButton}>
              <RotateCw size={13} strokeWidth={2} color={color.muted} />
            </IconButton>
          ) : null}
          <IconButton label={`Remove ${upload.file.name}`} onPress={() => onRemove(upload.key)} style={styles.trayButton}>
            <X size={13} strokeWidth={2} color={color.muted} />
          </IconButton>
        </View>
      ))}
    </View>
  )
}

export function Composer(props: {
  name: string
  busy: boolean
  stopping: boolean
  filesEnabled: boolean
  uploads: Upload[]
  onFiles: (files: LocalFile[]) => void
  onRemoveUpload: (key: string) => void
  onRetryUpload: (key: string) => void
  onSend: (text: string) => void
  onStop: () => void
}) {
  const [text, setText] = useState("")
  const hasFiles = props.uploads.length > 0
  const canSend = text.trim().length > 0 || (hasFiles && props.uploads.every((upload) => upload.status !== "failed"))
  // While an answer is in progress, a typed message is still sent (it is answered next); an empty box offers Stop.
  const showStop = props.busy && !canSend
  const send = () => {
    if (!canSend) return
    props.onSend(text)
    setText("")
  }
  return (
    <View style={[styles.composer, hasFiles || text.includes("\n") || text.length > 40 ? styles.composerTall : null]}>
      {hasFiles ? <UploadTray uploads={props.uploads} onRemove={props.onRemoveUpload} onRetry={props.onRetryUpload} /> : null}
      <View style={styles.row}>
        <AttachButton enabled={props.filesEnabled} onFiles={props.onFiles} />
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={`Message ${props.name}`}
          placeholderTextColor={color.faint}
          accessibilityLabel={`Message ${props.name}`}
          multiline
          style={styles.input}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showStop ? "Stop" : "Send"}
          disabled={showStop ? props.stopping : !canSend}
          onPress={showStop ? props.onStop : send}
          hitSlop={6}
          style={[styles.send, (showStop ? props.stopping : !canSend) ? styles.sendDisabled : null]}
        >
          {showStop ? <View style={styles.stopGlyph} /> : <ArrowUp size={16} strokeWidth={2.25} color={color.bg} />}
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  composer: { backgroundColor: color.surface, borderRadius: 26, paddingHorizontal: 7, paddingVertical: 7, boxShadow: shadow.composer, gap: 8 },
  composerTall: { borderRadius: 24 },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 4 },
  input: { flex: 1, minHeight: 36, maxHeight: 200, paddingHorizontal: 6, paddingTop: 8, paddingBottom: 8, fontSize: 16, lineHeight: 22, color: color.text },
  send: { width: 36, height: 36, borderRadius: 18, backgroundColor: color.ink, alignItems: "center", justifyContent: "center" },
  sendDisabled: { backgroundColor: color.disabled },
  stopGlyph: { width: 11, height: 11, borderRadius: 2.5, backgroundColor: color.bg },
  lockedClip: { backgroundColor: color.chip },
  lockBadge: { position: "absolute", right: 4, bottom: 4, width: 13, height: 13, borderRadius: 7, backgroundColor: color.muted, alignItems: "center", justifyContent: "center" },
  tray: { gap: 6, paddingHorizontal: 4, paddingTop: 4 },
  trayItem: { flexDirection: "row", alignItems: "center", gap: 10, padding: 6, borderRadius: 14, backgroundColor: color.tray },
  trayText: { flex: 1, minWidth: 0, gap: 3 },
  trayName: { fontSize: 13, fontWeight: "500", color: color.text },
  trayMeta: { fontSize: 11.5, color: color.muted },
  trayFailed: { fontSize: 11.5, color: color.danger },
  trayButton: { width: 30, height: 30 },
  progressTrack: { height: 3, borderRadius: 2, backgroundColor: color.bubble, overflow: "hidden", marginTop: 3 },
  progressFill: { height: 3, backgroundColor: color.ink },
})

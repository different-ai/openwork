import { CHAT_ID, extensionOf, formatSize, GRID_MAX_ROWS, inChat, kindLabel, parseDelimited, previewKind, type WorkbotAttachment, type WorkbotPreview } from "@openwork-ee/workbot-client"
import { useWorkbotChat, useWorkbotFileBytes, useWorkbotPreview, WorkbotChatProvider } from "@openwork-ee/workbot-client/hooks"
import { useQuery } from "@tanstack/react-query"
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio"
import { Image } from "expo-image"
import { router, useLocalSearchParams } from "expo-router"
import { useVideoPlayer, VideoView } from "expo-video"
import { Pause, Play, Share2, X } from "lucide-react-native"
import { useEffect, useMemo, useState } from "react"
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import WebView from "react-native-webview"
import { useSession } from "../../src/auth/session"
import { localCopy, shareFile } from "../../src/files/share"
import { FileBadge, useKeptImage } from "../../src/files/ui"
import { IconButton, PrimaryButton } from "../../src/ui/controls"
import { WorkbotMarkdown } from "../../src/ui/markdown"
import { color, shadow } from "../../src/theme"

/** A kept file on this phone (for players and viewers that read a local file). */
function useLocalFile(file: WorkbotAttachment, enabled: boolean) {
  const session = useSession()
  const chat = useWorkbotChat()
  return useQuery({
    queryKey: ["workbot", "local", chat ?? "main", file.id, file.updatedAt ?? 0],
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => (await localCopy(session, file, chat)).uri,
  })
}

function Loading() {
  return <View style={styles.fill}><ActivityIndicator color={color.muted} /></View>
}

/** No preview on this phone: what it is, and the way to open it elsewhere. */
function NoPreview({ file, reason }: { file: WorkbotAttachment; reason?: string }) {
  const session = useSession()
  const chat = useWorkbotChat()
  return (
    <View style={styles.fill}>
      <FileBadge name={file.name} mediaType={file.mediaType} size={56} />
      <Text style={styles.noName}>{file.name}</Text>
      <Text style={styles.noReason}>{reason ?? "There's no preview for this kind of file here."}</Text>
      <View style={styles.noAction}>
        <PrimaryButton label="Open in another app" onPress={() => void shareFile(session, file, chat)} />
      </View>
    </View>
  )
}

function ImagePreview({ file }: { file: WorkbotAttachment }) {
  const source = useKeptImage(file.id, file.updatedAt)
  return (
    <ScrollView maximumZoomScale={4} minimumZoomScale={1} centerContent contentContainerStyle={styles.zoom}>
      <Image source={source} style={styles.image} contentFit="contain" transition={120} accessibilityLabel={file.name} />
    </ScrollView>
  )
}

/** A rendered page (slides, documents, PDFs), at its true proportions. */
function PageImage({ fileId, page, version, ratio }: { fileId: string; page: number; version?: number; ratio: number }) {
  const session = useSession()
  const chat = useWorkbotChat()
  const [headers, setHeaders] = useState<Record<string, string> | null>(null)
  useEffect(() => {
    void session.authHeaders().then(setHeaders)
  }, [session])
  if (!headers) return <View style={[styles.page, { aspectRatio: ratio }]} />
  return (
    <Image
      source={{ uri: session.url(inChat(`/v1/workbot/files/${fileId}/preview/${page}`, chat)), headers, cacheKey: `workbot-page-${chat ?? "main"}-${fileId}-${version ?? 0}-${page}` }}
      style={[styles.page, { aspectRatio: ratio }]}
      contentFit="contain"
      accessibilityLabel={`Page ${page}`}
    />
  )
}

function Pages({ file, preview }: { file: WorkbotAttachment; preview: WorkbotPreview }) {
  return (
    <ScrollView contentContainerStyle={styles.pages}>
      {Array.from({ length: preview.pages }, (_, index) => (
        <PageImage key={index} fileId={file.id} page={index + 1} version={file.updatedAt} ratio={preview.width / preview.height} />
      ))}
    </ScrollView>
  )
}

/** PDFs show as pages when Workbot's computer rendered them; else iOS's own viewer, or another app on Android. */
function PdfPreview({ file }: { file: WorkbotAttachment }) {
  const preview = useWorkbotPreview(file.id, file.updatedAt)
  const local = useLocalFile(file, preview.isSuccess && !preview.data && Platform.OS === "ios")
  if (preview.data) return <Pages file={file} preview={preview.data} />
  if (preview.isPending) return <Loading />
  if (Platform.OS !== "ios") return <NoPreview file={file} reason="Open it in a PDF app to read it." />
  if (local.isError) return <NoPreview file={file} reason="This file couldn't load." />
  if (!local.data) return <Loading />
  return <WebView source={{ uri: local.data }} originWhitelist={["file://*"]} allowingReadAccessToURL={local.data} style={styles.web} />
}

/** Slides and documents: the pages Workbot's computer rendered; without them, another app opens them. */
function OfficePreview({ file }: { file: WorkbotAttachment }) {
  const preview = useWorkbotPreview(file.id, file.updatedAt)
  if (preview.data) return <Pages file={file} preview={preview.data} />
  if (preview.isPending) return <Loading />
  return <NoPreview file={file} />
}

function VideoPreview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri)
  return <VideoView player={player} style={styles.video} nativeControls contentFit="contain" />
}

function AudioPreview({ uri, name }: { uri: string; name: string }) {
  const player = useAudioPlayer(uri)
  const status = useAudioPlayerStatus(player)
  return (
    <View style={styles.fill}>
      <Text style={styles.noName}>{name}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={status.playing ? "Pause" : "Play"} onPress={() => (status.playing ? player.pause() : player.play())} style={styles.play}>
        {status.playing ? <Pause size={22} color={color.onInk} /> : <Play size={22} color={color.onInk} />}
      </Pressable>
    </View>
  )
}

function MediaPreview({ file, kind }: { file: WorkbotAttachment; kind: "video" | "audio" }) {
  const local = useLocalFile(file, true)
  if (local.isError) return <NoPreview file={file} reason="This file couldn't load." />
  if (!local.data) return <Loading />
  return kind === "video" ? <VideoPreview uri={local.data} /> : <AudioPreview uri={local.data} name={file.name} />
}

/** A read-only grid: a header row, hairlines, tabular numbers, and a row cap so huge sheets stay quick. */
function Grid({ rows }: { rows: string[][] }) {
  const [header = [], ...body] = rows.slice(0, GRID_MAX_ROWS)
  const columns = Math.max(header.length, ...body.map((row) => row.length))
  const cells = (row: string[], head: boolean) => Array.from({ length: columns }, (_, index) => <Text key={index} numberOfLines={1} style={[styles.cell, head ? styles.headCell : null]}>{row[index] ?? ""}</Text>)
  return (
    <ScrollView horizontal contentContainerStyle={styles.gridPad}>
      <ScrollView style={styles.grid}>
        <View style={[styles.gridRow, styles.gridHead]}>{cells(header, true)}</View>
        {body.map((row, index) => <View key={index} style={styles.gridRow}>{cells(row, false)}</View>)}
      </ScrollView>
    </ScrollView>
  )
}

/** Files read straight from their bytes: text, Markdown, CSV and HTML. */
function BytesPreview({ file, kind }: { file: WorkbotAttachment; kind: "markdown" | "csv" | "html" | "text" }) {
  const bytes = useWorkbotFileBytes(file.id, file.updatedAt)
  const text = useMemo(() => (bytes.data ? new TextDecoder().decode(bytes.data.subarray(0, 2_000_000)) : null), [bytes.data])
  if (bytes.isError) return <NoPreview file={file} reason="This file couldn't load." />
  if (text === null) return <Loading />
  if (kind === "markdown") return <ScrollView contentContainerStyle={styles.markdown}><WorkbotMarkdown text={text} /></ScrollView>
  if (kind === "csv") return <Grid rows={parseDelimited(text, extensionOf(file.name) === "tsv" ? "\t" : ",")} />
  if (kind === "html") {
    // Untrusted HTML runs on its own: scripts, but no way back into the app, and no leaving the page.
    return <WebView source={{ html: text }} originWhitelist={["about:*"]} onShouldStartLoadWithRequest={(request) => request.url.startsWith("about:")} javaScriptEnabled setSupportMultipleWindows={false} style={styles.web} />
  }
  return <ScrollView contentContainerStyle={styles.textPad}><Text selectable style={styles.code}>{text}</Text></ScrollView>
}

function FilePreview({ file }: { file: WorkbotAttachment }) {
  const kind = previewKind(file)
  if (kind === "image") return <ImagePreview file={file} />
  if (kind === "pdf") return <PdfPreview file={file} />
  if (kind === "video" || kind === "audio") return <MediaPreview file={file} kind={kind} />
  if (kind === "slides" || kind === "document") return <OfficePreview file={file} />
  if (kind === "markdown" || kind === "csv" || kind === "html" || kind === "text") return <BytesPreview file={file} kind={kind} />
  return <NoPreview file={file} />
}

function PreviewScreen({ file }: { file: WorkbotAttachment }) {
  const insets = useSafeAreaInsets()
  const session = useSession()
  const chat = useWorkbotChat()
  const { width } = useWindowDimensions()
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text numberOfLines={1} accessibilityRole="header" style={[styles.title, { maxWidth: width - 120 }]}>{file.name}</Text>
          <Text style={styles.subtitle}>{kindLabel(file.name, file.mediaType)}, {formatSize(file.size)}</Text>
        </View>
        <IconButton label={`Share ${file.name}`} onPress={() => void shareFile(session, file, chat)}>
          <Share2 size={17} strokeWidth={1.75} color={color.muted} />
        </IconButton>
        <IconButton label="Close preview" onPress={() => router.back()}>
          <X size={18} strokeWidth={2} color={color.muted} />
        </IconButton>
      </View>
      <View style={styles.body}>
        <FilePreview file={file} />
      </View>
    </View>
  )
}

/** A file opened by the person: the file itself, never a list of its properties. */
export default function Preview() {
  const params = useLocalSearchParams<{ id: string; name: string; mediaType: string; size: string; version: string; chat?: string }>()
  const chat = typeof params.chat === "string" && CHAT_ID.test(params.chat) ? params.chat : null
  const version = Number(params.version)
  const file: WorkbotAttachment = {
    id: String(params.id ?? ""),
    name: String(params.name ?? "file"),
    mediaType: String(params.mediaType ?? "application/octet-stream"),
    size: Number(params.size) || 0,
    ...(version ? { updatedAt: version } : {}),
  }
  return (
    <WorkbotChatProvider value={chat}>
      <PreviewScreen file={file} />
    </WorkbotChatProvider>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  header: { height: 56, flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 20, paddingRight: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.hairline },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: "600", color: color.text },
  subtitle: { fontSize: 12, color: color.muted },
  body: { flex: 1 },
  fill: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 24 },
  noName: { marginTop: 8, fontSize: 14, fontWeight: "500", color: color.text, textAlign: "center" },
  noReason: { fontSize: 13, color: color.muted, textAlign: "center" },
  noAction: { paddingTop: 16 },
  zoom: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  image: { width: "100%", height: "100%", minHeight: 300 },
  pages: { gap: 16, padding: 16 },
  page: { width: "100%", borderRadius: 8, backgroundColor: color.surface, boxShadow: shadow.card },
  web: { flex: 1, backgroundColor: color.surface },
  video: { flex: 1, backgroundColor: "#000" },
  play: { marginTop: 16, width: 56, height: 56, borderRadius: 28, backgroundColor: color.ink, alignItems: "center", justifyContent: "center" },
  markdown: { padding: 24 },
  textPad: { padding: 20 },
  code: { fontFamily: "Menlo", fontSize: 12, lineHeight: 20, color: color.text },
  gridPad: { padding: 16 },
  grid: { borderRadius: 12, backgroundColor: color.surface, boxShadow: shadow.card },
  gridRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.rowLine },
  gridHead: { backgroundColor: color.tray },
  cell: { width: 140, paddingHorizontal: 12, paddingVertical: 6, fontSize: 12.5, color: color.text, fontVariant: ["tabular-nums"] },
  headCell: { fontWeight: "600" },
})

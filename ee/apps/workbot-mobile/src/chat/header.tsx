import { chatTitle, initials } from "@openwork-ee/workbot-client"
import { router } from "expo-router"
import { ArrowLeft, FileText, PanelLeft, Trash2 } from "lucide-react-native"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { IconButton } from "../ui/controls"
import { OpenWorkMark } from "../ui/mark"
import { color } from "../theme"

/**
 * Workbot's header: the mark and its name (or a side chat's back button and name), Home / Calendar where the
 * Calendar is on, files, and the person's initials, which open their account.
 */
export function WorkbotHeader(props: {
  name: string
  organizationName: string
  userName: string | null
  /** The side chat on screen, with its name; null in the main chat. */
  side: { id: string; title: string | undefined } | null
  sideChats: boolean
  calendar: boolean
  tab: "home" | "calendar"
  filesEnabled: boolean
  onRemove?: () => void
}) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.header, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        {props.side ? (
          <View style={styles.left}>
            <IconButton label="Back to main chat" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}>
              <ArrowLeft size={18} strokeWidth={1.5} color={color.muted} />
            </IconButton>
            <Text numberOfLines={1} accessibilityRole="header" style={styles.title}>{chatTitle(props.side.title)}</Text>
          </View>
        ) : (
          <View style={styles.left}>
            {props.sideChats && props.tab === "home" ? (
              <IconButton label="Chats" onPress={() => router.push("/chats")}>
                <PanelLeft size={17} strokeWidth={1.5} color={color.muted} />
              </IconButton>
            ) : null}
            <View accessibilityLabel={`${props.name}, set up by ${props.organizationName}`} style={styles.brand}>
              <OpenWorkMark width={16} height={20} />
              <Text numberOfLines={1} accessibilityRole="header" style={styles.title}>{props.name}</Text>
            </View>
            {props.calendar ? (
              <View style={styles.nav} accessibilityRole="tablist">
                {(["home", "calendar"] as const).map((entry) => (
                  <Pressable
                    key={entry}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: props.tab === entry }}
                    onPress={() => (entry === props.tab ? undefined : entry === "calendar" ? router.push("/calendar") : router.back())}
                    style={[styles.navItem, props.tab === entry ? styles.navActive : null]}
                  >
                    <Text style={[styles.navText, props.tab === entry ? styles.navTextActive : null]}>{entry === "home" ? "Home" : "Calendar"}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        )}
        <View style={styles.right}>
          {props.onRemove ? (
            <IconButton label="Remove side chat" onPress={props.onRemove}>
              <Trash2 size={16} strokeWidth={1.5} color={color.muted} />
            </IconButton>
          ) : null}
          {props.filesEnabled && props.tab === "home" ? (
            <IconButton label="Files" onPress={() => router.push({ pathname: "/files", params: { name: props.name, ...(props.side ? { chat: props.side.id } : {}) } })}>
              <FileText size={17} strokeWidth={1.5} color={color.muted} />
            </IconButton>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Your account" onPress={() => router.push("/account")} hitSlop={6} style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(props.userName)}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  header: { backgroundColor: color.bg },
  bar: { height: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 10, gap: 8 },
  left: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
  brand: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 4, flexShrink: 1 },
  title: { fontSize: 15, fontWeight: "600", letterSpacing: -0.2, color: color.text, flexShrink: 1 },
  nav: { flexDirection: "row", gap: 2, marginLeft: 10 },
  navItem: { height: 32, paddingHorizontal: 10, borderRadius: 8, justifyContent: "center" },
  navActive: { backgroundColor: "#EDF0F2" },
  navText: { fontSize: 13, fontWeight: "500", color: "#687076" },
  navTextActive: { fontWeight: "600", color: "#11181C" },
  right: { flexDirection: "row", alignItems: "center", gap: 6 },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: color.ink, alignItems: "center", justifyContent: "center", marginLeft: 4 },
  avatarText: { fontSize: 11, fontWeight: "600", letterSpacing: 0.3, color: color.onInk },
})

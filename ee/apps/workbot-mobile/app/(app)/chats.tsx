import { chatTitle, CHAT_FILTER_FROM, newChatId, sinceLabel } from "@openwork-ee/workbot-client"
import { useWorkbotChats } from "@openwork-ee/workbot-client/hooks"
import { router } from "expo-router"
import { Plus } from "lucide-react-native"
import { useEffect, useState } from "react"
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { randomBytes } from "../../src/auth/pkce"
import { IconButton, QuietButton } from "../../src/ui/controls"
import { color } from "../../src/theme"

/** Opens a chat from the list: back to the conversation behind the sheet, then into the chat picked. */
function open(chat: string | null) {
  router.dismiss()
  if (chat) router.push({ pathname: "/chat/[id]", params: { id: chat } })
}

/**
 * The person's chats: the main chat, then their side chats, most recently used first, with "New side chat" next to
 * them. Side chats keep one topic apart and share the main chat's memory.
 */
export default function Chats() {
  const chats = useWorkbotChats(true)
  const [filter, setFilter] = useState("")
  const refetch = chats.refetch
  // The list says when each chat was last used: it is read again each time it opens.
  useEffect(() => {
    void refetch()
  }, [refetch])
  const side = chats.data?.side ?? []
  const query = filter.trim().toLowerCase()
  const shown = query ? side.filter((chat) => chatTitle(chat.title).toLowerCase().includes(query)) : side
  return (
    <View style={styles.sheet}>
      <Text accessibilityRole="header" style={styles.heading}>Chats</Text>
      <Pressable accessibilityRole="button" onPress={() => open(null)} style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}>
        <Text style={[styles.rowTitle, styles.main]}>Main chat</Text>
        {chats.data?.main ? <Text style={styles.since}>{sinceLabel(chats.data.main.updatedAt)}</Text> : null}
      </Pressable>
      <View style={styles.sectionRow}>
        <Text style={styles.section}>Side chats</Text>
        <IconButton label="New side chat" onPress={() => open(newChatId(randomBytes))}>
          <Plus size={18} strokeWidth={1.5} color={color.muted} />
        </IconButton>
      </View>
      {side.length >= CHAT_FILTER_FROM ? (
        <TextInput value={filter} onChangeText={setFilter} placeholder="Filter by name" placeholderTextColor={color.muted} accessibilityLabel="Filter side chats by name" style={styles.filter} />
      ) : null}
      {chats.isPending && !chats.data ? (
        <View style={styles.loading}>{[0, 1, 2].map((index) => <View key={index} style={styles.placeholder} />)}</View>
      ) : chats.isError && !chats.data ? (
        <View style={styles.note}>
          <Text style={styles.noteText}>Couldn't load your side chats.</Text>
          <QuietButton label="Try again" onPress={() => void refetch()} />
        </View>
      ) : side.length === 0 ? (
        <Text style={[styles.noteText, styles.note]}>No side chats yet.</Text>
      ) : shown.length === 0 ? (
        <Text style={[styles.noteText, styles.note]}>No side chat has that name.</Text>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(chat) => chat.id}
          renderItem={({ item }) => (
            <Pressable accessibilityRole="button" onPress={() => open(item.id)} style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}>
              <Text numberOfLines={1} style={[styles.rowTitle, item.title.trim() ? null : styles.untitled]}>{chatTitle(item.title)}</Text>
              <Text style={styles.since}>{sinceLabel(item.updatedAt)}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: color.surface, paddingHorizontal: 8, paddingTop: 20 },
  heading: { paddingHorizontal: 12, paddingBottom: 8, fontSize: 15, fontWeight: "600", color: color.text },
  row: { height: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, borderRadius: 10 },
  pressed: { backgroundColor: color.chip },
  rowTitle: { flex: 1, fontSize: 15, color: color.text },
  main: { fontWeight: "500" },
  untitled: { color: color.muted },
  since: { fontSize: 12, color: color.muted },
  sectionRow: { marginTop: 12, height: 40, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 12 },
  section: { fontSize: 12, fontWeight: "500", color: color.muted },
  filter: { marginHorizontal: 4, marginBottom: 6, height: 36, paddingHorizontal: 14, borderRadius: 999, backgroundColor: color.chip, fontSize: 14, color: color.text },
  loading: { gap: 18, paddingHorizontal: 12, paddingTop: 12 },
  placeholder: { width: 160, height: 12, borderRadius: 4, backgroundColor: color.chip },
  note: { paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  noteText: { fontSize: 13, lineHeight: 20, color: color.muted },
})

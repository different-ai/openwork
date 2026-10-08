import { initials } from "@openwork-ee/workbot-client"
import Constants from "expo-constants"
import { router } from "expo-router"
import { Linking, Pressable, StyleSheet, Text, View } from "react-native"
import { useSession } from "../../src/auth/session"
import { useMe } from "../../src/me"
import { color } from "../../src/theme"

/** The person: who is signed in and where; their OpenWork dashboard; signing out of this phone. */
export default function Account() {
  const me = useMe()
  const session = useSession()
  return (
    <View style={styles.sheet}>
      <View style={styles.who}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{initials(me.name)}</Text></View>
        <View style={styles.whoText}>
          <Text numberOfLines={1} style={styles.name}>{me.name ?? me.email}</Text>
          <Text numberOfLines={1} style={styles.meta}>{me.email}</Text>
          <Text numberOfLines={1} style={styles.meta}>{me.organizationName}</Text>
        </View>
      </View>
      <View style={styles.list}>
        {me.denUrl ? (
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(`${me.denUrl}/dashboard`)} style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}>
            <Text style={styles.rowText}>Open OpenWork</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            router.dismissAll()
            void session.signOut()
          }}
          style={({ pressed }) => [styles.row, styles.rowLine, pressed ? styles.pressed : null]}
        >
          <Text style={[styles.rowText, styles.danger]}>Sign out</Text>
        </Pressable>
      </View>
      <Text style={styles.version}>Workbot {Constants.expoConfig?.version ?? ""}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: color.surface, padding: 20, gap: 20 },
  who: { flexDirection: "row", alignItems: "center", gap: 14 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: color.ink, alignItems: "center", justifyContent: "center" },
  avatarText: { color: color.onInk, fontSize: 14, fontWeight: "600" },
  whoText: { flex: 1, gap: 2 },
  name: { fontSize: 16, fontWeight: "600", color: color.text },
  meta: { fontSize: 13, color: color.muted },
  list: { borderRadius: 14, backgroundColor: color.tray, overflow: "hidden" },
  row: { height: 50, justifyContent: "center", paddingHorizontal: 16 },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.rowLine },
  pressed: { backgroundColor: color.chip },
  rowText: { fontSize: 15, color: color.text },
  danger: { color: color.danger },
  version: { fontSize: 12, color: color.faint, textAlign: "center" },
})

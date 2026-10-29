import { Redirect } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSession } from "../src/auth/session"
import { isDevelopment, normalizeServer } from "../src/config"
import { PrimaryButton, QuietButton } from "../src/ui/controls"
import { OpenWorkMark } from "../src/ui/mark"
import { color, shadow } from "../src/theme"

/** Sign in with OpenWork: the system's sign-in browser opens OpenWork, then comes back here signed in. */
export default function SignIn() {
  const session = useSession()
  const insets = useSafeAreaInsets()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [server, setServer] = useState("")
  if (session.state.status === "signedIn") return <Redirect href="/" />
  const error = session.state.status === "signedOut" ? session.state.error : null
  return (
    <View style={[styles.page, { paddingTop: insets.top, paddingBottom: insets.bottom + 16 }]}>
      <View style={styles.center}>
        <OpenWorkMark width={40} height={50} />
        <Text accessibilityRole="header" style={styles.title}>Workbot</Text>
        <Text style={styles.body}>Your team's assistant, on your phone. Sign in with your OpenWork account.</Text>
        <View style={styles.action}>
          <PrimaryButton
            label="Sign in with OpenWork"
            busy={busy}
            onPress={() => {
              setBusy(true)
              void session.signIn().finally(() => setBusy(false))
            }}
          />
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      </View>
      {isDevelopment ? (
        <View style={styles.server}>
          {editing ? (
            <View style={styles.serverEdit}>
              <TextInput value={server} onChangeText={setServer} placeholder={session.server} placeholderTextColor={color.faint} autoCapitalize="none" autoCorrect={false} keyboardType="url" clearButtonMode="while-editing" autoFocus accessibilityLabel="Workbot address" style={styles.serverInput} />
              <QuietButton
                label="Use"
                disabled={!normalizeServer(server)}
                onPress={() => {
                  if (session.changeServer(server)) setEditing(false)
                }}
              />
            </View>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => { setServer(""); setEditing(true) }}>
              <Text style={styles.serverText}>Development build · {session.server} · Change</Text>
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg, paddingHorizontal: 24 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  title: { paddingTop: 28, fontSize: 28, lineHeight: 34, fontWeight: "600", letterSpacing: -0.5, color: color.text },
  body: { paddingTop: 8, maxWidth: 320, fontSize: 15, lineHeight: 22, color: color.muted, textAlign: "center" },
  action: { paddingTop: 36 },
  error: { paddingTop: 16, maxWidth: 320, fontSize: 13, lineHeight: 18, color: color.danger, textAlign: "center" },
  server: { alignItems: "center", gap: 6 },
  serverText: { fontSize: 12, color: color.faint },
  serverEdit: { flexDirection: "row", alignItems: "center", gap: 8, width: "100%" },
  serverInput: { flex: 1, height: 40, paddingHorizontal: 14, borderRadius: 999, backgroundColor: color.surface, fontSize: 14, color: color.text, boxShadow: shadow.ring },
})

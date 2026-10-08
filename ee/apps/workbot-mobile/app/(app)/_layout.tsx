import { useWorkbotMe } from "@openwork-ee/workbot-client/hooks"
import { Redirect, Stack } from "expo-router"
import { Lock } from "lucide-react-native"
import { ActivityIndicator, StyleSheet, Text, View } from "react-native"
import { useSession } from "../../src/auth/session"
import { MeContext } from "../../src/me"
import { PrimaryButton, QuietButton } from "../../src/ui/controls"
import { color } from "../../src/theme"

function Message({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <View style={styles.centered}>
      <Lock size={16} strokeWidth={1.5} color={color.muted} />
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      <View style={styles.action}>{action}</View>
    </View>
  )
}

/**
 * The signed-in app. Workbot says who the person is and what is on for them: the phone app has its own switch
 * (workbotMobile), so a workspace can have Workbot on the web without the phone app.
 */
export default function SignedInLayout() {
  const session = useSession()
  const me = useWorkbotMe(session.state.status === "signedIn")
  if (session.state.status !== "signedIn") return <Redirect href="/sign-in" />
  if (me.isPending) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={color.muted} />
      </View>
    )
  }
  if (me.isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>Workbot can't reach OpenWork right now.</Text>
        <View style={styles.action}>
          <PrimaryButton label="Try again" onPress={() => void me.refetch()} />
        </View>
      </View>
    )
  }
  if (!me.data) return <Redirect href="/sign-in" />
  if (!me.data.enabled) {
    return <Message title="Workbot isn't on for your organization yet." body="An admin can turn it on." action={<QuietButton label="Sign out" tone="muted" onPress={() => void session.signOut()} />} />
  }
  if (!me.data.mobile) {
    return <Message title="Workbot on your phone isn't on for your organization yet." body="An admin can turn it on. Workbot on the web works as before." action={<QuietButton label="Sign out" tone="muted" onPress={() => void session.signOut()} />} />
  }
  return (
    <MeContext.Provider value={me.data}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="chat/[id]" />
        <Stack.Screen name="calendar" options={{ animation: "fade" }} />
        <Stack.Screen name="chats" options={{ presentation: "formSheet", sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true }} />
        <Stack.Screen name="files" options={{ presentation: "formSheet", sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true }} />
        <Stack.Screen name="account" options={{ presentation: "formSheet", sheetAllowedDetents: [0.5, 0.75], sheetGrabberVisible: true }} />
        <Stack.Screen name="preview" options={{ presentation: "fullScreenModal" }} />
      </Stack>
    </MeContext.Provider>
  )
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, gap: 6, backgroundColor: color.bg },
  title: { marginTop: 6, fontSize: 14, color: color.text, textAlign: "center" },
  body: { fontSize: 13, color: color.muted, textAlign: "center" },
  action: { paddingTop: 16 },
})

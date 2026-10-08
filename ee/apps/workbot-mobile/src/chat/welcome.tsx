import { EVERYDAY_APP_NAMES, type WorkbotConnection } from "@openwork-ee/workbot-client"
import { useWorkbotConnections } from "@openwork-ee/workbot-client/hooks"
import { Check } from "lucide-react-native"
import { useEffect, useState } from "react"
import { AppState, Linking, Pressable, StyleSheet, Text, View } from "react-native"
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated"
import { AppMark } from "../ui/app-mark"
import { PrimaryButton, QuietButton } from "../ui/controls"
import { OpenWorkMark } from "../ui/mark"
import { useLessMotion } from "../ui/motion"
import { color, shadow } from "../theme"

/**
 * The first thing a person sees, once, before the conversation: a quiet hello, then (when their admins set any up)
 * their everyday apps to connect. One primary action per step; each step's parts rise in one after another.
 */
export function Welcome({ name, firstName, denUrl, onBegin, onDone }: { name: string; firstName: string | null; denUrl: string | null; onBegin: () => void; onDone: () => void }) {
  const [step, setStep] = useState<"hello" | "connect">("hello")
  const [waitingFor, setWaitingFor] = useState<string | null>(null)
  const connections = useWorkbotConnections({ enabled: true, waiting: waitingFor !== null })
  const list = connections.data ?? []
  const less = useLessMotion()

  // Stop re-reading once the app the person went to connect is ready.
  useEffect(() => {
    if (waitingFor && list.find((connection) => connection.id === waitingFor)?.ready) setWaitingFor(null)
  }, [list, waitingFor])
  // Back from the browser: read the connections again at once.
  const refetch = connections.refetch
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refetch()
    })
    return () => subscription.remove()
  }, [refetch])

  const finish = () => {
    onBegin()
    onDone()
  }
  const rise = (order: number) => (less ? undefined : FadeInDown.duration(200).delay(80 + order * 70))
  return (
    <View style={styles.page}>
      {step === "hello" ? (
        <Animated.View key="hello" exiting={less ? undefined : FadeOut.duration(180)} style={styles.column}>
          <Animated.View entering={rise(0)}><OpenWorkMark width={40} height={50} /></Animated.View>
          <Animated.Text entering={rise(1)} accessibilityRole="header" style={styles.title}>Hi{firstName ? ` ${firstName}` : ""}</Animated.Text>
          <Animated.Text entering={rise(2)} style={styles.body}>I'm {name}. I can help with your connected apps and take on longer jobs while you keep chatting.</Animated.Text>
          <Animated.View entering={rise(3)} style={styles.action}>
            <PrimaryButton label="Get started" disabled={connections.isPending} onPress={() => (list.length === 0 ? finish() : setStep("connect"))} />
          </Animated.View>
        </Animated.View>
      ) : (
        <Animated.View key="connect" style={styles.column}>
          <ConnectStep
            connections={list}
            waitingFor={waitingFor}
            denUrl={denUrl}
            rise={rise}
            onConnect={(connection) => {
              if (!connection.connectUrl) return
              setWaitingFor(connection.id)
              // The system browser keeps the OpenWork sign-in from a moment ago, so connecting needs no second sign-in.
              void Linking.openURL(connection.connectUrl)
            }}
            onContinue={finish}
          />
        </Animated.View>
      )}
    </View>
  )
}

function ConnectStep(props: {
  connections: WorkbotConnection[]
  waitingFor: string | null
  denUrl: string | null
  rise: (order: number) => ReturnType<typeof FadeInDown.duration> | undefined
  onConnect: (connection: WorkbotConnection) => void
  onContinue: () => void
}) {
  const allReady = props.connections.every((connection) => connection.ready)
  return (
    <>
      <Animated.Text entering={props.rise(0)} accessibilityRole="header" style={styles.connectTitle}>{allReady ? "You're all connected" : "Connect your apps"}</Animated.Text>
      <Animated.Text entering={props.rise(1)} style={styles.connectBody}>Set up for you by your team.</Animated.Text>
      <Animated.View entering={props.rise(2)} style={styles.list}>
        {props.connections.map((connection, index) => (
          <View key={connection.id} style={[styles.row, index > 0 ? styles.rowLine : null]}>
            <View style={styles.rowIcon}><AppMark name={EVERYDAY_APP_NAMES[connection.app]} size={18} denUrl={props.denUrl} /></View>
            <Text numberOfLines={1} style={styles.rowName}>{connection.name}</Text>
            {connection.ready ? (
              <View style={styles.connected}>
                <View style={styles.connectedCheck}><Check size={11} strokeWidth={3} color={color.onInk} /></View>
                <Text style={styles.connectedText}>Connected</Text>
              </View>
            ) : props.waitingFor === connection.id ? (
              <Text accessibilityLiveRegion="polite" style={styles.waiting}>Finish in your browser</Text>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel={`Connect ${connection.name}`} disabled={!connection.connectUrl} onPress={() => props.onConnect(connection)} style={({ pressed }) => [styles.connect, pressed ? styles.connectPressed : null]}>
                <Text style={styles.connectText}>Connect</Text>
              </Pressable>
            )}
          </View>
        ))}
      </Animated.View>
      <Animated.View entering={props.rise(3)} style={styles.connectActions}>
        <PrimaryButton label="Start chatting" onPress={props.onContinue} />
        {allReady ? null : <QuietButton label="Skip for now" tone="muted" onPress={props.onContinue} />}
      </Animated.View>
    </>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, backgroundColor: color.bg },
  column: { width: "100%", maxWidth: 400, alignItems: "center" },
  title: { paddingTop: 28, fontSize: 28, lineHeight: 34, fontWeight: "600", letterSpacing: -0.5, color: color.text, textAlign: "center" },
  body: { paddingTop: 8, fontSize: 15, lineHeight: 22, color: color.muted, textAlign: "center" },
  action: { paddingTop: 36 },
  connectTitle: { fontSize: 22, lineHeight: 28, fontWeight: "600", letterSpacing: -0.4, color: color.text, textAlign: "center" },
  connectBody: { paddingTop: 8, fontSize: 14, lineHeight: 20, color: color.muted },
  list: { marginTop: 28, width: "100%", borderRadius: 16, backgroundColor: color.surface, boxShadow: shadow.card, overflow: "hidden" },
  row: { height: 56, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16 },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.rowLine },
  rowIcon: { width: 32, height: 32, borderRadius: 9, backgroundColor: color.chip, alignItems: "center", justifyContent: "center" },
  rowName: { flex: 1, fontSize: 14, fontWeight: "500", color: color.text },
  connected: { flexDirection: "row", alignItems: "center", gap: 6 },
  connectedCheck: { width: 18, height: 18, borderRadius: 9, backgroundColor: color.ink, alignItems: "center", justifyContent: "center" },
  connectedText: { fontSize: 13, color: color.muted },
  waiting: { fontSize: 13, color: color.muted },
  connect: { height: 32, paddingHorizontal: 14, borderRadius: 999, justifyContent: "center", boxShadow: shadow.ring },
  connectPressed: { backgroundColor: color.chip },
  connectText: { fontSize: 13, fontWeight: "500", color: color.text },
  connectActions: { alignItems: "center", gap: 12, paddingTop: 32 },
})

import { firstOpenSuggestions, greetingWord, timestampLabel } from "@openwork-ee/workbot-client"
import type { ReactNode } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { AppMark } from "../ui/app-mark"
import { OpenWorkMark } from "../ui/mark"
import { color, COLUMN, shadow } from "../theme"

export function Timestamp({ at }: { at: number }) {
  return <Text style={styles.timestamp}>{timestampLabel(at)}</Text>
}

/** Who Workbot is and who set it up: on the first open, and afterwards at the top of the conversation. */
export function Identity({ name, organizationName }: { name: string; organizationName: string }) {
  return (
    <View style={styles.identity}>
      <OpenWorkMark width={36} height={45} />
      <Text style={styles.name}>{name}</Text>
      <Text style={styles.setUp}>Set up by {organizationName}</Text>
    </View>
  )
}

/** The drawn greeting, before Workbot's own hello (or in its place when it couldn't start). */
export function Intro(props: { name: string; organizationName: string; firstName: string | null; at: number; spoken: boolean; apps: string[] }) {
  const seeing = props.apps.length === 0 ? null : props.apps.length === 1 ? props.apps[0] : `${props.apps.slice(0, -1).join(", ")} and ${props.apps.at(-1)}`
  return (
    <View>
      <Identity name={props.name} organizationName={props.organizationName} />
      {props.spoken ? null : (
        <View style={styles.greeting}>
          <Timestamp at={props.at} />
          <Text style={[styles.bubble, styles.first]}>
            {greetingWord(props.at)}{props.firstName ? ` ${props.firstName}` : ""}.{seeing ? ` I can already see your ${seeing}.` : ""}
          </Text>
          <Text style={[styles.bubble, styles.second]}>What can I take off your plate today?</Text>
        </View>
      )}
    </View>
  )
}

/** The first open: the greeting, starters, and the composer, as one centered group. */
export function FirstOpen(props: { name: string; organizationName: string; firstName: string | null; apps: string[]; denUrl: string | null; at: number; error: ReactNode; onSuggestion: (text: string) => void; children: ReactNode }) {
  return (
    <View style={styles.center}>
      <View style={styles.column}>
        <Intro name={props.name} organizationName={props.organizationName} firstName={props.firstName} at={props.at} spoken={false} apps={props.apps} />
        {props.error}
        <View style={styles.starters}>
          {firstOpenSuggestions(props.apps).map((suggestion) => (
            <Pressable key={suggestion.text} accessibilityRole="button" onPress={() => props.onSuggestion(suggestion.text)} style={({ pressed }) => [styles.starter, pressed ? styles.starterPressed : null]}>
              {suggestion.app ? <AppMark name={suggestion.app} size={13} denUrl={props.denUrl} /> : null}
              <Text style={styles.starterText}>{suggestion.text}</Text>
            </Pressable>
          ))}
        </View>
        {props.children}
      </View>
    </View>
  )
}

/** A new side chat, before its first message: who the person is talking to, then the composer. */
export function SideChatStart(props: { name: string; organizationName: string; children: ReactNode }) {
  return (
    <View style={styles.center}>
      <View style={styles.column}>
        <Identity name={props.name} organizationName={props.organizationName} />
        {props.children}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  timestamp: { alignSelf: "center", paddingBottom: 12, fontSize: 12, fontWeight: "500", lineHeight: 16, color: color.muted },
  identity: { alignItems: "center", gap: 6, paddingBottom: 28 },
  name: { paddingTop: 4, fontSize: 15, fontWeight: "600", lineHeight: 18, color: color.text },
  setUp: { fontSize: 12, lineHeight: 16, color: color.muted },
  greeting: { gap: 3 },
  bubble: { alignSelf: "flex-start", maxWidth: 520, borderRadius: 20, backgroundColor: color.surface, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, lineHeight: 22, color: color.text, boxShadow: shadow.card, overflow: "hidden" },
  first: { borderBottomLeftRadius: 6 },
  second: { borderTopLeftRadius: 6 },
  center: { flex: 1, justifyContent: "center", paddingHorizontal: 16, paddingBottom: 48 },
  column: { width: "100%", maxWidth: COLUMN, alignSelf: "center", gap: 4 },
  starters: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingVertical: 18 },
  starter: { height: 34, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, paddingRight: 14, borderRadius: 999, backgroundColor: color.surface, boxShadow: shadow.ring },
  starterPressed: { backgroundColor: color.chip },
  starterText: { fontSize: 13, color: color.text },
})

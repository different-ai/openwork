import { CircleAlert } from "lucide-react-native"
import type { ReactNode } from "react"
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native"
import { color, shadow, TAP } from "../theme"

/** The one primary action of a step: ink, round. */
export function PrimaryButton({ label, onPress, disabled, busy }: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.primary, { opacity: disabled ? 0.6 : pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }]}
    >
      {busy ? <ActivityIndicator color={color.onInk} /> : <Text style={styles.primaryText}>{label}</Text>}
    </Pressable>
  )
}

/** A quiet text action ("Try again", "Skip for now"). */
export function QuietButton({ label, onPress, disabled, tone = "text" }: { label: string; onPress: () => void; disabled?: boolean; tone?: "text" | "muted" | "danger" }) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} hitSlop={8} style={({ pressed }) => [styles.quiet, pressed ? styles.quietPressed : null, disabled ? styles.disabled : null]}>
      <Text style={[styles.quietText, tone === "muted" ? styles.muted : tone === "danger" ? styles.danger : null]}>{label}</Text>
    </Pressable>
  )
}

/** An icon with a 44pt target. */
export function IconButton({ label, onPress, disabled, children, style, ...rest }: { label: string; children: ReactNode; style?: StyleProp<ViewStyle> } & Omit<PressableProps, "children" | "style">) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.icon, pressed ? styles.iconPressed : null, disabled ? styles.disabled : null, style]}
      {...rest}
    >
      {children}
    </Pressable>
  )
}

/**
 * A failure, inline where it happened: what didn't work in one short line and, when there is one, the next step as a
 * quiet button. The red mark says it's a failure without turning the sentence into an alarm.
 */
export function ErrorLine({ children, action = null, align = "start" }: { children: ReactNode; action?: { label: string; onPress: () => void } | null; align?: "start" | "end" }) {
  return (
    <View accessibilityRole="alert" style={[styles.errorLine, align === "end" ? styles.end : null]}>
      {/* The mark sits on the first line; longer text wraps beside it, never under it. */}
      <View style={styles.errorMark}>
        <CircleAlert size={14} strokeWidth={1.75} color={color.danger} />
      </View>
      <Text style={[styles.errorText, align === "end" ? styles.errorTextEnd : null]}>{children}</Text>
      {action ? (
        <View style={styles.errorAction}>
          <QuietButton label={action.label} onPress={action.onPress} />
        </View>
      ) : null}
    </View>
  )
}

/** A quiet line for the app's own waiting states ("Uploading your files", "Up next"): words only. */
export function QuietLine({ label }: { label: string }) {
  return (
    <Text accessibilityLiveRegion="polite" style={styles.quietLine}>
      {label}
    </Text>
  )
}

/** A card surface: white with Workbot's hairline shadow. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>
}

const styles = StyleSheet.create({
  primary: { height: TAP, minWidth: 168, paddingHorizontal: 24, borderRadius: 999, backgroundColor: color.ink, alignItems: "center", justifyContent: "center", boxShadow: "0 6px 16px -8px #01162780" },
  primaryText: { color: color.onInk, fontSize: 15, fontWeight: "500" },
  quiet: { minHeight: 32, paddingHorizontal: 10, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  quietPressed: { backgroundColor: color.chip },
  quietText: { fontSize: 13, fontWeight: "500", color: color.text },
  muted: { color: color.muted, fontWeight: "400" },
  danger: { color: color.danger },
  disabled: { opacity: 0.4 },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  iconPressed: { backgroundColor: color.chip },
  errorLine: { flexDirection: "row", alignItems: "flex-start", gap: 6, paddingTop: 6, paddingLeft: 4 },
  end: { justifyContent: "flex-end", paddingRight: 4, paddingLeft: 0 },
  errorMark: { height: 18, justifyContent: "center" },
  errorText: { flexShrink: 1, fontSize: 13, lineHeight: 18, color: color.muted },
  errorTextEnd: { textAlign: "right" },
  // A 32pt button centred on the 18pt first line.
  errorAction: { marginTop: -7, marginLeft: -2 },
  quietLine: { height: 24, paddingLeft: 4, fontSize: 13, lineHeight: 24, color: color.faint },
  card: { backgroundColor: color.surface, borderRadius: 14, boxShadow: shadow.card },
})

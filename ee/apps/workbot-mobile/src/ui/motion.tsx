import { useEffect, useState } from "react"
import { AccessibilityInfo, StyleSheet, View } from "react-native"
import Animated, { Easing, useAnimatedProps, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated"
import Svg, { Circle, G, Path, Rect } from "react-native-svg"
import { color, shadow } from "../theme"

/**
 * Workbot's motion, only where it means "working" (DESIGN V6): typing dots, its computer at work, a gently pulsing
 * live line. Reduced motion stops all of it.
 */

/** True once `flag` has held for `ms`, so an indicator doesn't flash for a beat between two steps. */
export function useSettled(flag: boolean, ms: number) {
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (!flag) {
      setSettled(false)
      return
    }
    const timer = setTimeout(() => setSettled(true), ms)
    return () => clearTimeout(timer)
  }, [flag, ms])
  return flag && settled
}

/** Ticks once a second while mounted. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** Whether the person asked for less motion. */
export function useLessMotion() {
  const reduced = useReducedMotion()
  const [system, setSystem] = useState(false)
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setSystem)
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setSystem)
    return () => subscription.remove()
  }, [])
  return reduced || system
}

function Dot({ index }: { index: number }) {
  const opacity = useSharedValue(0.35)
  const less = useLessMotion()
  useEffect(() => {
    if (less) return
    opacity.value = withDelay(index * 160, withRepeat(withSequence(withTiming(1, { duration: 360 }), withTiming(0.35, { duration: 360 })), -1))
  }, [index, less, opacity])
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }))
  return <Animated.View style={[styles.dot, style]} />
}

/** Workbot writing a reply that doesn't show yet: one small bubble with three dots that darken in turn. */
export function TypingBubble() {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Workbot is processing" style={styles.typingWrap}>
      <View style={styles.typing}>
        <Dot index={0} />
        <Dot index={1} />
        <Dot index={2} />
      </View>
    </View>
  )
}

/** A line that pulses gently while something is running ("Using Gmail"). */
export function Pulse({ active, children }: { active: boolean; children: React.ReactNode }) {
  const opacity = useSharedValue(1)
  const less = useLessMotion()
  useEffect(() => {
    if (!active || less) {
      opacity.value = 1
      return
    }
    opacity.value = withRepeat(withSequence(withTiming(0.45, { duration: 900, easing: Easing.inOut(Easing.ease) }), withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) })), -1)
  }, [active, less, opacity])
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }))
  return <Animated.View style={style}>{children}</Animated.View>
}

const AnimatedPath = Animated.createAnimatedComponent(Path)
const AnimatedG = Animated.createAnimatedComponent(G)

/**
 * A little person at Workbot's computer: while it works the lines on the screen write themselves and their head nods
 * along; when it's done they sit back.
 */
export function WorkerGlyph({ working }: { working: boolean }) {
  const line = useSharedValue(1)
  const nod = useSharedValue(0)
  const less = useLessMotion()
  useEffect(() => {
    if (!working || less) {
      line.value = 1
      nod.value = 0
      return
    }
    line.value = withRepeat(withSequence(withTiming(0.25, { duration: 500 }), withTiming(1, { duration: 500 })), -1)
    nod.value = withRepeat(withSequence(withTiming(0.6, { duration: 450 }), withTiming(0, { duration: 450 })), -1)
  }, [working, less, line, nod])
  const first = useAnimatedProps(() => ({ strokeOpacity: line.value }))
  const second = useAnimatedProps(() => ({ strokeOpacity: 1.25 - line.value }))
  const head = useAnimatedProps(() => ({ transform: [{ translateY: nod.value }] }))
  return (
    <Svg viewBox="0 0 28 28" width={28} height={28} fill="none">
      <Path d="M2.5 21h23" stroke={color.computerFrame} strokeWidth={1.25} strokeLinecap="round" />
      <Rect x={14.5} y={12.25} width={10.5} height={7.5} rx={1.5} fill={color.computerScreen} stroke={color.ink} strokeWidth={1.25} />
      <Path d="M13 21h12.5" stroke={color.ink} strokeWidth={1.5} strokeLinecap="round" />
      <AnimatedPath animatedProps={first} d="M17 15h4" stroke={working ? color.computerLineLive : color.computerLine} strokeWidth={1.25} strokeLinecap="round" />
      <AnimatedPath animatedProps={second} d="M17 17.3h5.5" stroke={working ? color.computerLineLive : color.computerLine} strokeWidth={1.25} strokeLinecap="round" />
      <Path d="M4.5 21v-4.2a3.3 3.3 0 0 1 3.3-3.3h0.4a3.3 3.3 0 0 1 3.3 3.3v4.2" fill={color.ink} />
      <AnimatedG animatedProps={head}>
        <Circle cx={8} cy={9.6} r={2.6} fill={color.ink} />
      </AnimatedG>
      <Path d="M10.2 16.8l3.6 2.5" stroke={color.ink} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  )
}

const styles = StyleSheet.create({
  typingWrap: { paddingTop: 6, paddingLeft: 4, flexDirection: "row" },
  typing: { height: 36, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 16, borderRadius: 20, borderBottomLeftRadius: 6, backgroundColor: color.surface, boxShadow: shadow.card },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.muted },
})

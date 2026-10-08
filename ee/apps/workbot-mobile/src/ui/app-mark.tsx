import { appIconCandidates } from "@openwork-ee/workbot-client"
import { Image } from "expo-image"
import { useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import { color } from "../theme"

/** A connected app's logo, bare, from the same sources in the same order as the web page; a letter when none loads. */
export function AppMark({ name, size = 12, denUrl }: { name: string; size?: number; denUrl: string | null }) {
  const candidates = appIconCandidates(name, denUrl)
  const [index, setIndex] = useState(0)
  const source = candidates[index]
  if (!source) {
    return (
      <View style={[styles.letter, { width: size, height: size, borderRadius: size / 4 }]}>
        <Text style={[styles.letterText, { fontSize: Math.max(8, size * 0.62) }]}>{name.trim().charAt(0).toUpperCase() || "?"}</Text>
      </View>
    )
  }
  return <Image source={source} style={{ width: size, height: size }} contentFit="contain" onError={() => setIndex((current) => current + 1)} accessibilityIgnoresInvertColors />
}

const styles = StyleSheet.create({
  letter: { alignItems: "center", justifyContent: "center", backgroundColor: color.chip },
  letterText: { color: color.muted, fontWeight: "600" },
})

import { focusManager, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as Network from "expo-network"
import { Stack } from "expo-router"
import * as SplashScreen from "expo-splash-screen"
import { StatusBar } from "expo-status-bar"
import { useEffect, useState } from "react"
import { AppState } from "react-native"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { KeyboardProvider } from "react-native-keyboard-controller"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { SessionProvider, useSession } from "../src/auth/session"
import { color } from "../src/theme"

void SplashScreen.preventAutoHideAsync()

// The app being on screen counts as the page having focus, and the phone's connection as being online.
focusManager.setEventListener((setFocused) => {
  const subscription = AppState.addEventListener("change", (state) => setFocused(state === "active"))
  return () => subscription.remove()
})
onlineManager.setEventListener((setOnline) => {
  const subscription = Network.addNetworkStateListener((state) => setOnline(state.isConnected !== false))
  return () => subscription.remove()
})

function Screens() {
  const { state } = useSession()
  useEffect(() => {
    if (state.status !== "loading") void SplashScreen.hideAsync()
  }, [state.status])
  if (state.status === "loading") return null
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }}>
      <Stack.Screen name="(app)" />
      <Stack.Screen name="sign-in" options={{ animation: "fade" }} />
      <Stack.Screen name="auth/callback" options={{ animation: "none" }} />
    </Stack>
  )
}

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }))
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.bg }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <QueryClientProvider client={queryClient}>
            <SessionProvider>
              <StatusBar style="dark" />
              <Screens />
            </SessionProvider>
          </QueryClientProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

import { Redirect } from "expo-router"

/**
 * Where the sign-in browser returns (`…:/auth/callback`). The sign-in itself reads the address; on Android the system
 * also opens the app here, so this only goes back to the conversation.
 */
export default function AuthCallback() {
  return <Redirect href="/" />
}

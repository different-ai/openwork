import type { ConfigContext, ExpoConfig } from "expo/config"

/**
 * Workbot on iPhone and Android. Two builds of one app: `production` (com.openworklabs.workbot, always
 * https://chat.openworklabs.com) and `development` (com.openworklabs.workbot.dev, any Workbot you point it at,
 * installable next to the other). APP_VARIANT picks one; development is the default for local builds.
 */
const variant = process.env.APP_VARIANT === "production" ? "production" : "development"
const production = variant === "production"
const id = production ? "com.openworklabs.workbot" : "com.openworklabs.workbot.dev"
const WORKBOT_HOST = "chat.openworklabs.com"
/**
 * Where Workbot sends the production app back after signing in: a page on Workbot that iOS and Android open only in
 * this app, verified against Workbot's /.well-known files, so no other app can take the code. Development builds come
 * back to their own scheme, which only a Workbot on this computer accepts.
 */
const AUTH_CALLBACK_PATH = "/auth/app/callback"

/** Development builds start from EXPO_PUBLIC_WORKBOT_URL: https, or plain http only on this computer (loopback). */
function developmentWorkbotUrl(value = "http://localhost:3020") {
  const url = new URL(value)
  if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return url.origin
  throw new Error(`EXPO_PUBLIC_WORKBOT_URL must be an https address, or http on localhost: ${value}`)
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: production ? "Workbot" : "Workbot Dev",
  slug: "workbot",
  version: "0.1.0",
  // The app's own address for links into it (and the development build's sign-in return).
  scheme: id,
  orientation: "portrait",
  userInterfaceStyle: "light",
  icon: "./assets/icon.png",
  backgroundColor: "#fbfcfd",
  ios: {
    bundleIdentifier: id,
    supportsTablet: false,
    // The sign-in browser hands an https return address back to the app from iOS 17.4.
    ...(production ? { deploymentTarget: "17.4", associatedDomains: [`applinks:${WORKBOT_HOST}`, `webcredentials:${WORKBOT_HOST}`] } : {}),
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      NSCameraUsageDescription: "Take a photo to send to Workbot.",
      NSPhotoLibraryUsageDescription: "Choose photos to send to Workbot.",
      // Development builds talk to a Workbot on this computer over plain http.
      ...(production ? {} : { NSAppTransportSecurity: { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true } }),
    },
  },
  android: {
    package: id,
    allowBackup: false,
    adaptiveIcon: { foregroundImage: "./assets/adaptive-icon.png", backgroundColor: "#fbfcfd" },
    permissions: ["android.permission.CAMERA"],
    blockedPermissions: ["android.permission.RECORD_AUDIO"],
    ...(production
      ? { intentFilters: [{ action: "VIEW", autoVerify: true, data: [{ scheme: "https", host: WORKBOT_HOST, path: AUTH_CALLBACK_PATH }], category: ["BROWSABLE", "DEFAULT"] }] }
      : {}),
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-web-browser",
    ["expo-image-picker", { photosPermission: "Choose photos to send to Workbot.", cameraPermission: "Take a photo to send to Workbot.", microphonePermission: false }],
    ["expo-splash-screen", { image: "./assets/splash-icon.png", imageWidth: 72, resizeMode: "contain", backgroundColor: "#fbfcfd" }],
    "expo-video",
    "expo-audio",
    ...(production ? [] : [["./plugins/with-local-http", {}] as [string, object]]),
  ],
  experiments: { typedRoutes: true },
  extra: {
    variant,
    // Production always talks to Workbot's own address; development builds start from this one and can change it.
    workbotUrl: production ? `https://${WORKBOT_HOST}` : developmentWorkbotUrl(process.env.EXPO_PUBLIC_WORKBOT_URL || undefined),
    redirectUri: production ? `https://${WORKBOT_HOST}${AUTH_CALLBACK_PATH}` : `${id}:/auth/callback`,
  },
})

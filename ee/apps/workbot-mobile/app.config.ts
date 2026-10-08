import type { ConfigContext, ExpoConfig } from "expo/config"

/**
 * Workbot on iPhone and Android. Two builds of one app: `production` (com.openworklabs.workbot, always
 * https://chat.openworklabs.com) and `development` (com.openworklabs.workbot.dev, any Workbot you point it at,
 * installable next to the other). APP_VARIANT picks one; development is the default for local builds.
 */
const variant = process.env.APP_VARIANT === "production" ? "production" : "development"
const production = variant === "production"
const id = production ? "com.openworklabs.workbot" : "com.openworklabs.workbot.dev"

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: production ? "Workbot" : "Workbot Dev",
  slug: "workbot",
  version: "0.1.0",
  // The app's own address: Workbot sends people back here after they sign in with OpenWork.
  scheme: id,
  orientation: "portrait",
  userInterfaceStyle: "light",
  icon: "./assets/icon.png",
  backgroundColor: "#fbfcfd",
  ios: {
    bundleIdentifier: id,
    supportsTablet: false,
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
    workbotUrl: production ? "https://chat.openworklabs.com" : (process.env.EXPO_PUBLIC_WORKBOT_URL ?? "http://localhost:3020"),
    redirectUri: `${id}:/auth/callback`,
  },
})

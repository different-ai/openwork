// Expo configures Metro for this monorepo on its own. One addition: packages that must exist once in the app
// (React, React Native, and TanStack Query, whose client lives in a React context) always resolve from this app, even when a shared
// workspace package imports them from its own development install.
const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")

const config = getDefaultConfig(__dirname)
const SINGLETONS = new Set(["react", "react-native", "@tanstack/react-query"])
const fromApp = path.join(__dirname, "package.json")

function packageName(request) {
  if (request.startsWith(".") || request.startsWith("/")) return null
  const parts = request.split("/")
  return request.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

const resolve = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, request, platform) => {
  const name = packageName(request)
  const next = name && SINGLETONS.has(name) ? { ...context, originModulePath: fromApp } : context
  return resolve ? resolve(next, request, platform) : next.resolveRequest(next, request, platform)
}

module.exports = config

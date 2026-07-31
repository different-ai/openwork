import type { AppManifest } from "../src/manifest.js"

/**
 * A realistic, fully valid manifest.
 *
 * Tests mutate a deep clone of this to prove that each rule fails closed; a
 * mutation that still validates means the rule is missing, not that the
 * manifest is lenient.
 */
export function validManifest(): AppManifest {
  return {
    manifest_version: 1,
    id: "com.openworklabs.station",
    name: "OpenWork Station",
    description:
      "An ambient assistant that listens on request, notices what you are working on, and prepares useful context at the edge of the screen.",
    version: "1.0.0",
    publisher: { name: "OpenWork Labs", url: "https://openworklabs.com" },
    repository: "https://github.com/different-ai/openwork-station",
    license: "MIT",
    icons: { default: "assets/icon.svg" },
    engines: {
      openwork: { min: "0.1.0" },
      app_api: { min: "1.0.0", max_exclusive: "2.0.0" },
    },
    platforms: [{ os: "darwin", arch: ["arm64", "x64"] }],
    distribution: {
      type: "github-release",
      repository: "https://github.com/different-ai/openwork-station",
      asset: "openwork-station-{version}.owapp",
    },
    entrypoints: {
      background: "dist/background.js",
      surfaces: { station: "dist/station/index.html" },
    },
    contributions: [
      {
        type: "surface",
        id: "station",
        entrypoint: "station",
        presentation: "floating",
        default_size: { width: 360, height: 220 },
        anchor: "right-center",
      },
      {
        type: "right_sidebar_item",
        id: "station-rail",
        label: "Station",
        surface: "station",
        icon: "assets/icon.svg",
        order: 100,
      },
      { type: "background", id: "station-agent", entrypoint: "background" },
      { type: "command", id: "toggle-active", title: "Toggle Station active mode" },
      { type: "shortcut", id: "toggle-active-shortcut", command: "toggle-active", global: true },
      {
        type: "setting",
        kind: "boolean",
        id: "show-transcript",
        label: "Show live transcript",
        default: false,
      },
      { type: "status", id: "station-status", target: "station-rail", display: "dot" },
    ],
    permissions: [
      { id: "runtime.background.continuous", reason: "Notice opportunities while you work." },
      { id: "audio.microphone", reason: "Transcribe what you say while listening is on." },
      { id: "ai.realtime", reason: "Stream speech to a realtime transcription model." },
      { id: "ai.inference.transient", reason: "Decide whether a moment is worth researching." },
      {
        id: "openwork.connect.read",
        reason: "Find the messages, mail, and events that make a suggestion useful.",
        scopes: ["slack.search", "gmail.search", "calendar.events.read"],
      },
      { id: "openwork.threads.start", reason: "Hand a prepared goal to OpenWork when you accept it." },
      { id: "openwork.attachments.create", reason: "Attach the relevant transcript excerpt if you choose to." },
      {
        id: "desktop.globalShortcut",
        reason: "Toggle listening without leaving your current app.",
        shortcuts: [{ id: "toggle-active-shortcut", default_accelerator: "CommandOrControl+Shift+Space" }],
      },
      {
        id: "desktop.floatingSurface",
        reason: "Keep a small island at the edge of the screen.",
        always_on_top: true,
      },
      {
        id: "network.host",
        reason: "Reach the OpenAI realtime endpoint.",
        hosts: ["api.openai.com"],
      },
      { id: "storage.app", reason: "Remember dismissed cards between sessions.", quota_bytes: 1_048_576 },
    ],
    environment: {
      required: [
        {
          key: "OPENAI_API_KEY",
          label: "OpenAI API key",
          description: "Used by OpenWork to mint short-lived realtime credentials. Station never reads the value.",
        },
      ],
      optional: [],
    },
    privacy: {
      summary:
        "Audio is transcribed while listening is on and is never stored. Transcript excerpts leave the app only when you start a thread.",
      data_handled: ["microphone-audio", "transcripts", "connected-source-content"],
      retention: {
        policy: "session",
        description: "Transcripts and cards are held in memory for the listening session and dropped on stop.",
      },
      third_parties: [
        { name: "OpenAI", host: "api.openai.com", purpose: "Realtime transcription and structured decisions." },
      ],
    },
    update: { channel: "github-release", rollback_supported: true },
  }
}

export function clone<T>(value: T): T {
  return structuredClone(value)
}

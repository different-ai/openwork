import type {
  UiArtifactProjectFile,
  UiArtifactProjectFiles,
} from "@openwork/types/ui-artifact-project"

const manifest = {
  protocol: "openwork.ui-artifact-project",
  schemaVersion: 2,
  apiVersion: 1,
  slug: "launch-radar",
  title: "Launch Radar",
  description: "A reusable mission dashboard generated as a React artifact project.",
  runtime: {
    kind: "react",
    entry: "src/App.tsx",
    styles: "styles.css",
  },
  data: {
    value: "data.json",
    schema: "data.schema.json",
  },
  presentation: {
    placement: "both",
    shape: "collection",
  },
  intents: [{
    id: "launch.explain",
    title: "Explain launch risk",
    description: "Ask the agent to explain the currently selected launch risk.",
    arguments: [{
      name: "mission",
      type: "string",
      required: true,
      description: "Mission name to explain.",
    }],
    effects: {
      data: "read",
      ui: "none",
      external: false,
    },
    confirmation: "never",
  }],
} as const

const source = `type Launch = {
  id: string
  name: string
  window: string
  readiness: number
  tone: string
}

type LaunchRadarProps = {
  data: { launches: Launch[] }
  state: { watching?: string } | null
  runtime: {
    replaceState(next: { watching?: string }): void
    invoke(intentId: string, payload: Record<string, unknown>): Promise<unknown>
  }
}

export default function LaunchRadar({ data, state, runtime }: LaunchRadarProps) {
  const primary = data.launches[0]
  const watching = state?.watching

  return (
    <main className="launch-radar">
      <section className="primary">
        <div className="primary-heading">
          <div>
            <p className="eyebrow">NEXT WINDOW · {primary.window}</p>
            <h2>{primary.name}</h2>
          </div>
          <div className="readiness">
            <strong>{primary.readiness}%</strong>
            <span>ready</span>
          </div>
        </div>
        <button
          className="watch-button"
          onClick={() => runtime.replaceState({ watching: primary.id })}
        >
          {watching === primary.id ? "Watching Apollo" : "Watch launch"}
        </button>
      </section>
      <ol className="launch-list">
        {data.launches.slice(0, 5).map((launch) => (
          <li key={launch.id} style={{ "--mission-tone": launch.tone }}>
            <span className="tone" aria-hidden="true" />
            <strong>{launch.name}</strong>
            <span className="window">{launch.window}</span>
            <meter min="0" max="100" value={launch.readiness} />
            <span className="percent">{launch.readiness}%</span>
          </li>
        ))}
      </ol>
      {data.launches.length > 5 ? <p className="remainder">+ {data.launches.length - 5} more</p> : null}
      <button
        className="agent-button"
        onClick={() => runtime.invoke("launch.explain", { mission: primary.name })}
      >
        Ask agent about launch risk
      </button>
    </main>
  )
}
`

const styles = `:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #070b16;
  color: #f8fafc;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 0; }
button { font: inherit; }
.launch-radar {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
  padding: 16px;
  background:
    radial-gradient(circle at 90% 0%, rgba(77, 208, 225, .16), transparent 34%),
    linear-gradient(145deg, #0a1020 0%, #070b16 60%, #111936 100%);
}
.primary {
  display: grid;
  gap: 9px;
  border: 1px solid rgba(103, 232, 249, .24);
  border-radius: 14px;
  padding: 12px;
  background: rgba(15, 23, 42, .72);
}
.primary-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.eyebrow { margin: 0 0 3px; overflow: hidden; color: #67e8f9; font-size: 10px; font-weight: 800; letter-spacing: .12em; text-overflow: ellipsis; white-space: nowrap; }
h2, p { margin: 0; }
h2 { overflow: hidden; font-size: 20px; text-overflow: ellipsis; white-space: nowrap; }
.readiness { display: grid; flex: none; text-align: right; }
.readiness strong { font-size: 18px; }
.readiness span { color: #94a3b8; font-size: 10px; }
.watch-button {
  width: 100%;
  border: 1px solid rgba(103, 232, 249, .55);
  border-radius: 9px;
  padding: 7px 12px;
  background: rgba(8, 145, 178, .28);
  color: #ecfeff;
  font-size: 12px;
  font-weight: 750;
  cursor: pointer;
}
.launch-list { display: grid; margin: 0; padding: 0; list-style: none; }
.launch-list li { display: grid; grid-template-columns: 6px minmax(70px, 1fr) minmax(76px, auto) minmax(70px, 1fr) 34px; align-items: center; gap: 8px; min-height: 42px; border-bottom: 1px solid rgba(148, 163, 184, .14); }
.launch-list li:last-child { border-bottom: 0; }
.tone { width: 6px; height: 6px; border-radius: 50%; background: var(--mission-tone); box-shadow: 0 0 10px var(--mission-tone); }
.launch-list strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.window, .percent { color: #94a3b8; font-size: 10px; white-space: nowrap; }
.percent { text-align: right; }
meter { width: 100%; min-width: 0; height: 8px; accent-color: var(--mission-tone); }
.remainder { color: #94a3b8; font-size: 10px; }
.agent-button { display: block; margin: auto auto 0; border: 0; background: transparent; color: #a5b4fc; font-size: 11px; cursor: pointer; }
`

const data = {
  launches: [
    { id: "apollo", name: "Apollo", window: "T−00:42:18", readiness: 94, tone: "#67e8f9" },
    { id: "kepler", name: "Kepler", window: "T−03:16:04", readiness: 78, tone: "#a5b4fc" },
    { id: "voyager", name: "Voyager", window: "T−18:09:51", readiness: 61, tone: "#f0abfc" },
  ],
}

const dataSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["launches"],
  properties: {
    launches: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "name", "window", "readiness", "tone"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          window: { type: "string" },
          readiness: { type: "number", minimum: 0, maximum: 100 },
          tone: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
}

export const DYNAMIC_ARTIFACT_EVAL_PROJECT = {
  "artifact.json": JSON.stringify(manifest, null, 2) + "\n",
  "src/App.tsx": source,
  "styles.css": styles,
  "data.json": JSON.stringify(data, null, 2) + "\n",
  "data.schema.json": JSON.stringify(dataSchema, null, 2) + "\n",
} satisfies UiArtifactProjectFiles

export const DYNAMIC_ARTIFACT_EVAL_PROJECT_FILES = Object.entries(
  DYNAMIC_ARTIFACT_EVAL_PROJECT,
) as Array<[UiArtifactProjectFile, string]>

export const DYNAMIC_ARTIFACT_EVAL_INITIAL_STATE = {}

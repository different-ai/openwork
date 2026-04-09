import {
  PaperGrainGradient,
  PaperMeshGradient,
  getSeededPaperGrainGradientConfig,
  getSeededPaperMeshGradientConfig,
} from "@openwork/ui/react"
import { useMemo, useState } from "react"

const sampleIds = [
  "om_01kmhbscaze02vp04ykqa4tcsb",
  "om_01kmhbscazf4cjf1bssx6v9q9",
  "ow_01kmj2wc68r1zk4n8v7j6v1n2k",
]

export function App() {
  const [seed, setSeed] = useState(sampleIds[0])
  const normalizedSeed = seed.trim() || sampleIds[0]
  const parsedSeed = parseTypeId(normalizedSeed)
  const meshConfig = useMemo(() => getSeededPaperMeshGradientConfig(normalizedSeed), [normalizedSeed])
  const grainConfig = useMemo(() => getSeededPaperGrainGradientConfig(normalizedSeed), [normalizedSeed])

  return (
    <main className="app-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <section className="hero-card panel">
        <div className="hero-copy">
          <span className="eyebrow">OpenWork UI demo</span>
          <h1>Seeded Paper gradients on their own dev surface</h1>
          <p>
            Type a TypeID-like string, inspect the deterministic values derived from it, and preview
            the gradients that `@openwork/ui/react` will render anywhere else in the repo.
          </p>
        </div>

        <div className="rule-card">
          <span className="eyebrow muted">Deterministic</span>
          <strong>Same seed, same result.</strong>
          <p>Useful for stable identity-driven art direction across apps.</p>
        </div>
      </section>

      <section className="controls-grid">
        <div className="panel input-panel">
          <label className="eyebrow muted" htmlFor="seed-id">
            Seed id
          </label>
          <input
            id="seed-id"
            className="seed-input"
            type="text"
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
            spellCheck={false}
          />

          <div className="sample-list">
            {sampleIds.map((sampleId) => (
              <button
                key={sampleId}
                type="button"
                className={sampleId === normalizedSeed ? "sample-chip active" : "sample-chip"}
                onClick={() => setSeed(sampleId)}
              >
                {sampleId}
              </button>
            ))}
          </div>
        </div>

        <div className="panel seed-meta-grid">
          <SeedMeta label="prefix" value={parsedSeed.prefix ?? "-"} />
          <SeedMeta label="suffix" value={parsedSeed.suffix ?? "-"} />
          <SeedMeta label="suffix first 5" value={parsedSeed.suffixAnchor ?? "-"} />
          <SeedMeta label="suffix tail" value={parsedSeed.suffixTail ?? "-"} />
        </div>
      </section>

      <section className="preview-grid">
        <GradientCard
          title="Mesh gradient"
          subtitle="Shared mesh defaults plus seeded color and motion variation"
          colors={meshConfig.colors}
          config={meshConfig}
          surface={<PaperMeshGradient seed={normalizedSeed} className="gradient-fill" />}
        />

        <GradientCard
          title="Grain gradient"
          subtitle="Shared grain defaults plus seeded background, shape, and values"
          colors={[grainConfig.colorBack, ...grainConfig.colors]}
          config={grainConfig}
          surface={<PaperGrainGradient seed={normalizedSeed} className="gradient-fill" />}
        />
      </section>

      <section className="footer-grid">
        <div className="panel">
          <span className="eyebrow muted">Determinism check</span>
          <div className="mini-grid">
            <MiniPreview title="Mesh A">
              <PaperMeshGradient seed={normalizedSeed} className="gradient-fill" />
            </MiniPreview>
            <MiniPreview title="Mesh B">
              <PaperMeshGradient seed={normalizedSeed} className="gradient-fill" />
            </MiniPreview>
          </div>
          <p className="support-copy">
            These two cards use the same seed and should always match.
          </p>
        </div>

        <div className="panel code-panel">
          <span className="eyebrow muted">Import paths</span>
          <div className="pill-stack">
            <code className="import-pill">@openwork/ui/react</code>
            <code className="import-pill">@openwork/ui/solid</code>
          </div>
          <pre>{`import { PaperMeshGradient, PaperGrainGradient } from "@openwork/ui/react"

<PaperMeshGradient seed="${normalizedSeed}" />
<PaperGrainGradient seed="${normalizedSeed}" />`}</pre>
        </div>
      </section>
    </main>
  )
}

function GradientCard({
  title,
  subtitle,
  colors,
  config,
  surface,
}: {
  title: string
  subtitle: string
  colors: string[]
  config: Record<string, unknown>
  surface: React.ReactNode
}) {
  return (
    <article className="panel preview-card">
      <div className="gradient-surface">
        {surface}
        <div className="surface-overlay" />
        <div className="surface-copy">
          <span className="eyebrow on-dark">@openwork/ui/react</span>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>

      <div className="details-stack">
        <div>
          <span className="eyebrow muted">Colors</span>
          <div className="swatch-list">
            {colors.map((color) => (
              <div key={color} className="swatch-pill">
                <span className="swatch-dot" style={{ backgroundColor: color }} />
                <code>{color}</code>
              </div>
            ))}
          </div>
        </div>

        <div>
          <span className="eyebrow muted">Calculated values</span>
          <pre>{JSON.stringify(config, null, 2)}</pre>
        </div>
      </div>
    </article>
  )
}

function MiniPreview({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="eyebrow muted">{title}</span>
      <div className="mini-surface">{children}</div>
    </div>
  )
}

function SeedMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="seed-meta-card">
      <span className="eyebrow muted">{label}</span>
      <code>{value}</code>
    </div>
  )
}

function parseTypeId(value: string) {
  const separatorIndex = value.indexOf("_")

  if (separatorIndex === -1) {
    return {
      prefix: null,
      suffix: value,
      suffixAnchor: value.slice(0, 5) || null,
      suffixTail: value.slice(5) || null,
    }
  }

  const prefix = value.slice(0, separatorIndex) || null
  const suffix = value.slice(separatorIndex + 1) || null

  return {
    prefix,
    suffix,
    suffixAnchor: suffix?.slice(0, 5) || null,
    suffixTail: suffix?.slice(5) || null,
  }
}

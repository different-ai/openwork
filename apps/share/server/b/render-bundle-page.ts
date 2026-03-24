import {
  OPENWORK_DOWNLOAD_URL,
  SHARE_EASE,
  buildBundleNarrative,
  buildBundleUrls,
  buildOgImageUrls,
  buildOpenInAppUrls,
  collectBundleItems,
  escapeHtml,
  escapeJsonForScript,
  humanizeType,
  parseBundle,
  wantsDownload,
} from "../_lib/share-utils.ts";
import type { RequestLike } from "../_lib/types.ts";

export { buildBundleUrls, wantsDownload } from "../_lib/share-utils.ts";

export function renderBundlePage({ id, rawJson, req }: { id: string; rawJson: string; req: RequestLike }): string {
  const bundle = parseBundle(rawJson);
  const urls = buildBundleUrls(req, id);
  const ogImageUrls = buildOgImageUrls(req, id);
  const ogImageUrl = ogImageUrls.default;
  const { openInAppDeepLink } = buildOpenInAppUrls(urls.shareUrl, {
    label: bundle.name || "Shared worker package",
  });

  const schemaVersion = bundle.schemaVersion == null ? "unknown" : String(bundle.schemaVersion);
  const typeLabel = humanizeType(bundle.type);
  const title = bundle.name || `OpenWork ${typeLabel}`;
  const description = bundle.description || buildBundleNarrative(bundle);
  const items = collectBundleItems(bundle, 8);
  const compactItem = bundle.type === "skill" ? "skill.md" : items[0]?.name || "OpenWork bundle";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} - OpenWork Share</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="openwork:bundle-id" content="${escapeHtml(id)}" />
  <meta name="openwork:bundle-type" content="${escapeHtml(bundle.type || "unknown")}" />
  <meta name="openwork:schema-version" content="${escapeHtml(schemaVersion)}" />
  <meta name="openwork:open-in-app-url" content="${escapeHtml(openInAppDeepLink)}" />
  <link rel="canonical" href="${escapeHtml(urls.shareUrl)}" />
  <link rel="alternate" type="application/json" href="${escapeHtml(urls.jsonUrl)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${escapeHtml(urls.shareUrl)}" />
  <meta property="og:image" content="${escapeHtml(ogImageUrl)}" />
  <meta property="og:image" content="${escapeHtml(ogImageUrls.byVariant.linkedin)}" />
  <meta property="og:image" content="${escapeHtml(ogImageUrls.byVariant.slack)}" />
  <meta property="og:image" content="${escapeHtml(ogImageUrls.byVariant.whatsapp)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImageUrls.twitter)}" />
  <style>
    @font-face {
      font-family: "FK Raster Roman Compact Smooth";
      src: url("https://openworklabs.com/fonts/FKRasterRomanCompact-Smooth.woff2") format("woff2");
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    :root {
      color-scheme: light;
      --ow-bg: #f6f9fc;
      --ow-ink: #011627;
      --ow-muted: #5f6b7a;
      --ow-card: #ffffff;
      --ow-border: rgba(148, 163, 184, 0.16);
      --ow-shadow: 0 20px 60px -24px rgba(15, 23, 42, 0.18);
      --ow-primary: #011627;
      --ow-ease: ${SHARE_EASE};
      --ow-sans: Inter, "Segoe UI", "Helvetica Neue", sans-serif;
      --ow-accent: "FK Raster Roman Compact Smooth", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
    }

    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      font-family: var(--ow-sans);
      color: var(--ow-ink);
      background-color: var(--ow-bg);
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    body::after {
      content: "";
      position: absolute;
      top: 0;
      right: 0;
      width: 60vw;
      height: 80vh;
      background: radial-gradient(circle at 70% 30%, rgba(100, 116, 139, 0.25) 0%, transparent 60%);
      filter: blur(60px);
      z-index: 0;
      pointer-events: none;
    }

    a { color: inherit; }

    .shell {
      position: relative;
      z-index: 10;
      width: min(100%, 1024px);
      margin: 0 auto;
      padding: 8px 32px 64px;
    }

    .nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 80px;
      margin-bottom: 40px;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      text-decoration: none;
      font-weight: 600;
      font-size: 20px;
      letter-spacing: -0.02em;
      color: var(--ow-ink);
    }

    .brand-mark {
      width: 24px;
      height: 24px;
      background: url('data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="%23011627" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>') no-repeat center center;
    }

    .nav-links { display: none; }
    @media (min-width: 768px) {
      .nav-links {
        display: flex;
        gap: 32px;
        font-size: 15px;
        color: var(--ow-muted);
        font-weight: 500;
      }
      .nav-links a { text-decoration: none; transition: color 0.2s; }
      .nav-links a:hover { color: var(--ow-ink); }
    }

    .nav-actions { display: flex; align-items: center; gap: 12px; }

    .button-primary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 48px;
      padding: 0 24px;
      border-radius: 999px;
      border: none;
      cursor: pointer;
      text-decoration: none;
      color: #fff;
      background: var(--ow-primary);
      box-shadow: 0 14px 32px -16px rgba(1, 22, 39, 0.55);
      font-family: inherit;
      font-weight: 500;
      font-size: 16px;
      transition: all 300ms var(--ow-ease);
      will-change: transform, background-color, box-shadow;
    }

    .button-primary:hover {
      background: rgb(110, 110, 110);
      transform: translateY(-1px);
      box-shadow:
        rgba(0, 0, 0, 0.06) 0px 0px 0px 1px,
        rgba(0, 0, 0, 0.04) 0px 1px 2px 0px,
        rgba(0, 0, 0, 0.04) 0px 2px 4px 0px;
    }

    .button-secondary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 48px;
      padding: 0 24px;
      border-radius: 999px;
      text-decoration: none;
      background: rgb(255, 255, 255);
      color: rgb(0, 0, 0);
      border: none;
      box-shadow:
        rgba(0, 0, 0, 0.06) 0px 0px 0px 1px,
        rgba(0, 0, 0, 0.04) 0px 1px 2px 0px;
      font-family: inherit;
      font-weight: 500;
      font-size: 16px;
      transition: all 300ms var(--ow-ease);
      cursor: pointer;
      will-change: transform, background-color, box-shadow;
    }

    .button-secondary:hover {
      background: rgb(242, 242, 242);
      box-shadow:
        rgba(0, 0, 0, 0.06) 0px 0px 0px 1px,
        rgba(0, 0, 0, 0.04) 0px 1px 2px 0px,
        rgba(0, 0, 0, 0.04) 0px 2px 4px 0px;
    }

    .hero-layout {
      display: flex;
      flex-direction: column;
      gap: 64px;
    }
    @media (min-width: 1024px) {
      .hero-layout { flex-direction: row; align-items: flex-start; }
    }

    .hero-copy {
      flex: 1.1;
      max-width: 600px;
    }

    h1 {
      margin: 0 0 24px 0;
      font-size: clamp(3rem, 5.5vw, 4.5rem);
      line-height: 1.1;
      letter-spacing: -0.04em;
      font-weight: 500;
      color: var(--ow-ink);
    }

    h1 em {
      font-style: normal;
      font-family: var(--ow-accent);
      font-weight: 400;
      font-size: 1.05em;
      display: inline-block;
      vertical-align: baseline;
    }

    .hero-body {
      margin: 0 0 32px 0;
      font-size: 20px;
      line-height: 1.6;
      color: #374151;
      max-width: 500px;
    }

    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: center;
    }

    .hero-artifact {
      flex: 0.9;
      width: 100%;
    }

    .app-window {
      background: rgba(255, 255, 255, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.6);
      border-radius: 1.5rem;
      box-shadow: 0 20px 50px -24px rgba(15, 23, 42, 0.12);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      width: 100%;
    }

    .app-window-header {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px 16px;
      background: linear-gradient(to bottom, rgba(255,255,255,0.9), rgba(255,255,255,0.6));
      border-bottom: 1px solid rgba(255,255,255,0.5);
      position: relative;
    }

    .mac-dots {
      position: absolute;
      left: 16px;
      display: flex;
      gap: 6px;
    }
    .mac-dot { width: 12px; height: 12px; border-radius: 50%; }
    .mac-dot.red { background: #ff5f56; border: 1px solid rgba(224, 68, 62, 0.2); }
    .mac-dot.yellow { background: #ffbd2e; border: 1px solid rgba(222, 161, 35, 0.2); }
    .mac-dot.green { background: #27c93f; border: 1px solid rgba(26, 171, 41, 0.2); }

    .app-window-title {
      font-size: 12px;
      font-weight: 500;
      color: var(--ow-muted);
      letter-spacing: 0.02em;
    }

    .app-window-body {
      padding: 24px;
      background: #ffffff;
    }

    .included-section {
      width: 100%;
    }
    .included-section h4 {
      margin: 0 0 12px 0;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--ow-muted);
    }
    .included-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .included-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: #f8fafc;
      border: 1px solid rgba(148, 163, 184, 0.15);
      border-radius: 12px;
    }
    .item-left { display: flex; align-items: center; gap: 12px; }
    .item-dot { width: 24px; height: 24px; border-radius: 50%; }
    .dot-agent { background: #f97316; }
    .dot-skill { background: #2463eb; }
    .dot-mcp { background: #0f9f7f; }
    .dot-command { background: #8b5cf6; }
    .dot-config { background: #475569; }

    .item-title { font-size: 14px; font-weight: 500; color: var(--ow-ink); }
    .item-meta { font-size: 12px; color: var(--ow-muted); }

    .results-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 24px;
      margin-top: 64px;
    }
    @media (min-width: 768px) {
      .results-grid { grid-template-columns: 1fr 1fr; }
    }

    .result-card {
      background: #ffffff;
      border: 1px solid var(--ow-border);
      border-radius: 1.5rem;
      padding: 32px;
      box-shadow: var(--ow-shadow);
    }
    .result-card h3 { margin: 0 0 8px 0; font-size: 20px; font-weight: 500; }
    .result-card p { margin: 0 0 24px 0; font-size: 15px; color: var(--ow-muted); line-height: 1.6; }

    .url-box {
      background: #f8fafc;
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 12px;
      padding: 16px;
      font-family: ui-monospace, monospace;
      font-size: 13px;
      color: var(--ow-ink);
      word-break: break-all;
      margin-bottom: 16px;
    }

    .metadata-list {
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .metadata-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      font-size: 13px;
    }
    .metadata-list dt { color: var(--ow-muted); }
    .metadata-list dd { margin: 0; color: var(--ow-ink); font-weight: 500; }
  </style>
</head>
<body
  data-openwork-share="true"
  data-openwork-bundle-id="${escapeHtml(id)}"
  data-openwork-bundle-type="${escapeHtml(bundle.type || "unknown")}"
  data-openwork-schema-version="${escapeHtml(schemaVersion)}"
>
  <main class="shell">
    <nav class="nav">
      <a class="brand" href="/" aria-label="OpenWork Share home">
        <span class="brand-mark" aria-hidden="true"></span>
        <span>openwork</span>
      </a>
      <div class="nav-links">
        <a href="https://openworklabs.com/docs" target="_blank" rel="noreferrer">Docs</a>
        <a href="${escapeHtml(OPENWORK_DOWNLOAD_URL)}" target="_blank" rel="noreferrer">Download</a>
        <a href="https://openworklabs.com/enterprise" target="_blank" rel="noreferrer">Enterprise</a>
      </div>
      <div class="nav-actions">
        <a class="button-secondary" href="https://github.com/different-ai/openwork" target="_blank" rel="noreferrer">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
          GitHub
        </a>
      </div>
    </nav>

    <section class="hero-layout">
      <div class="hero-copy">
        <h1>${escapeHtml(title)} <em>ready</em></h1>
        <p class="hero-body">${escapeHtml(description)}</p>
        <div class="hero-actions">
          <a class="button-primary" href="${escapeHtml(openInAppDeepLink)}">Open in OpenWork app</a>
          <a class="button-secondary" href="https://openworklabs.com/den" target="_blank" rel="noreferrer">Open in an OpenWork den</a>
        </div>
      </div>

      <div class="hero-artifact">
        <div class="app-window">
          <div class="app-window-header">
            <div class="mac-dots">
              <div class="mac-dot red"></div>
              <div class="mac-dot yellow"></div>
              <div class="mac-dot green"></div>
            </div>
            <div class="app-window-title">OpenWork</div>
          </div>
          <div class="app-window-body">
            <div class="included-section">
              <h4>Skills:</h4>
              <div class="included-list">
                <div class="included-item"><div class="item-left"><div class="item-dot dot-skill"></div><span class="item-title">${escapeHtml(compactItem)}</span></div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="results-grid">
      <div class="result-card">
        <div class="step-list">
          <div class="step-row"><span class="step-bullet">01</span><span>Open the bundle in OpenWork</span></div>
          <div class="step-row"><span class="step-bullet">02</span><span>Choose the destination worker</span></div>
          <div class="step-row"><span class="step-bullet">03</span><span>Happy OpenWorking!</span></div>
        </div>
      </div>
    </section>

  </main>

  <script id="openwork-bundle-json" type="application/json">${escapeJsonForScript(rawJson)}</script>
  <script>
  </script>
</body>
</html>`;
}

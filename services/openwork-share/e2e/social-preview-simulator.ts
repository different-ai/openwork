export type SocialPreviewScenario = {
  key: string;
  label: string;
  surfaceWidth: number;
  surfaceHeight: number;
  previewWidth: number;
  previewHeight: number;
  minDarkPixelRatio: number;
};

type Region = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const TITLE_REGION: Region = {
  left: 170 / 1200,
  top: 210 / 630,
  width: 420 / 1200,
  height: 150 / 630,
};

export const SOCIAL_PREVIEW_SCENARIOS: SocialPreviewScenario[] = [
  {
    key: "whatsapp-small",
    label: "WhatsApp / small",
    surfaceWidth: 520,
    surfaceHeight: 270,
    previewWidth: 420,
    previewHeight: 221,
    minDarkPixelRatio: 0.028,
  },
  {
    key: "slack-medium",
    label: "Slack / medium",
    surfaceWidth: 640,
    surfaceHeight: 335,
    previewWidth: 520,
    previewHeight: 273,
    minDarkPixelRatio: 0.027,
  },
  {
    key: "twitter-large",
    label: "Twitter / large",
    surfaceWidth: 760,
    surfaceHeight: 400,
    previewWidth: 610,
    previewHeight: 320,
    minDarkPixelRatio: 0.024,
  },
];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildPngDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

export function getScenarioTitleRegion(scenario: SocialPreviewScenario): Region {
  return {
    left: Math.round(scenario.previewWidth * TITLE_REGION.left),
    top: Math.round(scenario.previewHeight * TITLE_REGION.top),
    width: Math.max(1, Math.round(scenario.previewWidth * TITLE_REGION.width)),
    height: Math.max(1, Math.round(scenario.previewHeight * TITLE_REGION.height)),
  };
}

function buildPreviewTileHtml(options: {
  imageUrl: string;
  scenario: SocialPreviewScenario;
}): string {
  const { imageUrl, scenario } = options;
  return `
    <section class="social-tile" data-scenario="${escapeHtml(scenario.key)}">
      <h2>${escapeHtml(scenario.label)}</h2>
      <div class="surface" style="width:${scenario.surfaceWidth}px;height:${scenario.surfaceHeight}px;">
        <img
          alt="${escapeHtml(scenario.label)} preview"
          src="${escapeHtml(imageUrl)}"
          width="${scenario.previewWidth}"
          height="${scenario.previewHeight}"
          style="width:${scenario.previewWidth}px;height:${scenario.previewHeight}px;"
        />
      </div>
    </section>
  `;
}

function buildGalleryHtml(options: {
  imageUrl: string;
  heading?: string;
}): string {
  const heading = options.heading ? `<h1 class="gallery-heading">${escapeHtml(options.heading)}</h1>` : "";
  const tiles = SOCIAL_PREVIEW_SCENARIOS.map((scenario) =>
    buildPreviewTileHtml({ imageUrl: options.imageUrl, scenario }),
  ).join("");

  return `
    <section class="gallery-block">
      ${heading}
      <div class="gallery-row">${tiles}</div>
    </section>
  `;
}

export function buildSocialPreviewGalleryHtml(options: {
  imageUrl: string;
  heading?: string;
}): string {
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Social preview simulation</title>
        <style>
          :root {
            color-scheme: light;
            font-family: Inter, ui-sans-serif, system-ui, sans-serif;
          }

          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            background: #f5f8fc;
            color: #0f172a;
            padding: 20px;
          }

          .gallery-block {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }

          .gallery-heading {
            margin: 0;
            font-size: 18px;
            font-weight: 600;
            color: #334155;
          }

          .gallery-row {
            display: flex;
            gap: 32px;
            align-items: flex-start;
          }

          .social-tile {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }

          .social-tile h2 {
            margin: 0;
            font-size: 18px;
            font-weight: 500;
            color: #94a3b8;
          }

          .surface {
            position: relative;
            overflow: hidden;
            border-radius: 22px;
            border: 1px solid #d8e2ee;
            background:
              radial-gradient(circle at 3px 3px, rgba(159, 176, 197, 0.26) 1.3px, transparent 1.3px),
              linear-gradient(135deg, #f7fbff 0%, #e5edf7 55%, #d8e4f1 100%);
            background-size: 14px 14px, auto;
            background-position: 8px 8px, 0 0;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
          }

          .surface img {
            position: absolute;
            left: 50%;
            top: 50%;
            transform: translate(-50%, -50%);
            display: block;
            border-radius: 18px;
            box-shadow: 0 10px 24px rgba(1, 22, 39, 0.08), 0 2px 6px rgba(1, 22, 39, 0.05);
          }
        </style>
      </head>
      <body>
        ${buildGalleryHtml(options)}
      </body>
    </html>`;
}

export function buildSocialPreviewComparisonHtml(options: {
  beforeImageUrl: string;
  afterImageUrl: string;
}): string {
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Social preview comparison</title>
        <style>
          :root {
            color-scheme: light;
            font-family: Inter, ui-sans-serif, system-ui, sans-serif;
          }

          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            background: #f5f8fc;
            color: #0f172a;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 28px;
          }

          .gallery-block {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }

          .gallery-heading {
            margin: 0;
            font-size: 18px;
            font-weight: 600;
            color: #334155;
          }

          .gallery-row {
            display: flex;
            gap: 32px;
            align-items: flex-start;
          }

          .social-tile {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }

          .social-tile h2 {
            margin: 0;
            font-size: 18px;
            font-weight: 500;
            color: #94a3b8;
          }

          .surface {
            position: relative;
            overflow: hidden;
            border-radius: 22px;
            border: 1px solid #d8e2ee;
            background:
              radial-gradient(circle at 3px 3px, rgba(159, 176, 197, 0.26) 1.3px, transparent 1.3px),
              linear-gradient(135deg, #f7fbff 0%, #e5edf7 55%, #d8e4f1 100%);
            background-size: 14px 14px, auto;
            background-position: 8px 8px, 0 0;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
          }

          .surface img {
            position: absolute;
            left: 50%;
            top: 50%;
            transform: translate(-50%, -50%);
            display: block;
            border-radius: 18px;
            box-shadow: 0 10px 24px rgba(1, 22, 39, 0.08), 0 2px 6px rgba(1, 22, 39, 0.05);
          }
        </style>
      </head>
      <body>
        ${buildGalleryHtml({ imageUrl: options.beforeImageUrl, heading: "Before" })}
        ${buildGalleryHtml({ imageUrl: options.afterImageUrl, heading: "After" })}
      </body>
    </html>`;
}

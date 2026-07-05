import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "download-light-card";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const CARD_SELECTOR = '[data-testid="download-openwork-card"]';
const LINK_SELECTOR = '[data-testid="download-openwork-link"]';
const INSTALLER_LABELS = [
  "Apple Silicon (M1+)",
  "Intel",
  "x64 Installer",
  "ARM64 Installer",
  "AppImage (x64)",
  "AppImage (ARM64)",
  "tar.gz (x64)",
  "tar.gz (ARM64)",
];

function routeUrl(ctx, path) {
  return new URL(path, ctx.env.OPENWORK_EVAL_LANDING_URL).toString();
}

async function navigateToDownload(ctx) {
  await ctx.eval(`location.href = ${JSON.stringify(routeUrl(ctx, "/download"))}; true`);
  await ctx.waitFor(
    `Boolean(document.querySelector(${JSON.stringify(CARD_SELECTOR)})) && document.body.innerText.includes("Download OpenWork")`,
    { timeoutMs: 30_000, label: "/download light download card" },
  );
}

function recordAssertion(ctx, assertion, passed, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

export default {
  id: FLOW_ID,
  title: "Landing /download serves the light Download OpenWork card",
  kind: "user-facing",
  spec: "evals/README.md",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_LANDING_URL"],
  steps: [
    {
      name: "/download renders the light-mode card",
      run: async (ctx) => {
        await ctx.prove("/download renders the light-mode Download OpenWork card", {
          voiceover: vo[0],
          action: async () => {
            await navigateToDownload(ctx);
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const card = document.querySelector(${JSON.stringify(CARD_SELECTOR)});
              const backgroundColor = card ? getComputedStyle(card).backgroundColor : "";
              const match = backgroundColor.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
              const channels = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [];
              return {
                cardExists: Boolean(card),
                bodyHasTitle: document.body.innerText.includes("Download OpenWork"),
                backgroundColor,
                channels,
                isLight: channels.length === 3 && channels.every((channel) => channel >= 240),
              };
            })()`);
            recordAssertion(
              ctx,
              "The Download OpenWork card exists on /download",
              actual.cardExists === true && actual.bodyHasTitle === true,
              actual,
            );
            recordAssertion(
              ctx,
              "The card background is light with RGB channels at least 240",
              actual.isLight === true,
              actual,
            );
          },
          screenshot: {
            name: "download-light-card",
            requireText: ["Download OpenWork"],
          },
        });
      },
    },
    {
      name: "All installer assets are offered",
      run: async (ctx) => {
        await ctx.prove("All 8 installers are offered with working links", {
          voiceover: vo[1],
          action: async () => {
            await ctx.waitFor(
              `document.querySelectorAll(${JSON.stringify(LINK_SELECTOR)}).length === 8`,
              { timeoutMs: 30_000, label: "all eight download links" },
            );
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const labels = ${JSON.stringify(INSTALLER_LABELS)};
              const card = document.querySelector(${JSON.stringify(CARD_SELECTOR)});
              const text = card ? card.innerText : "";
              const links = Array.from(card ? card.querySelectorAll(${JSON.stringify(LINK_SELECTOR)}) : []);
              const hrefs = links.map((link) => link.href);
              return {
                missingLabels: labels.filter((label) => !text.includes(label)),
                linkCount: links.length,
                hrefs,
                invalidHrefs: hrefs.filter((href) => !/^https?:\\/\\//.test(href) || !href.includes("github.com")),
              };
            })()`);
            recordAssertion(
              ctx,
              "The card contains every required installer label",
              actual.missingLabels.length === 0,
              actual,
            );
            recordAssertion(
              ctx,
              "The card renders exactly 8 GitHub http(s) download links",
              actual.linkCount === 8 && actual.invalidHrefs.length === 0,
              actual,
            );
          },
          screenshot: {
            name: "download-all-assets",
            requireText: INSTALLER_LABELS,
          },
        });
      },
    },
    {
      name: "Visitor OS is detected and badged",
      run: async (ctx) => {
        await ctx.prove("The visitor's OS is detected and badged", {
          voiceover: vo[2],
          action: async () => {
            await ctx.waitFor(
              `(() => {
                const card = document.querySelector(${JSON.stringify(CARD_SELECTOR)});
                if (!card) return false;
                return Array.from(card.querySelectorAll("span")).some((span) => span.textContent.trim() === "Detected" && span.getClientRects().length > 0);
              })()`,
              { timeoutMs: 30_000, label: "Detected OS badge" },
            );
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const card = document.querySelector(${JSON.stringify(CARD_SELECTOR)});
              const badges = Array.from(card ? card.querySelectorAll("span") : []).filter((span) => span.textContent.trim() === "Detected");
              const badge = badges[0] || null;
              return {
                badgeVisible: Boolean(badge && badge.getClientRects().length > 0),
                columnOS: badge?.previousElementSibling?.textContent?.trim() || "",
              };
            })()`);
            ctx.recordEvidence({
              type: "output",
              name: "Detected badge column",
              text: actual.columnOS,
            });
            recordAssertion(
              ctx,
              "A visible Detected pill is rendered inside the card with an OS column label",
              actual.badgeVisible === true && actual.columnOS.length > 0,
              actual,
            );
          },
          screenshot: {
            name: "download-detected-badge",
            requireText: ["Detected"],
          },
        });
      },
    },
  ],
};

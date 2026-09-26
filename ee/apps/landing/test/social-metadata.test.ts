import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Metadata } from "next";
import { resolveOpenGraph, resolveTwitter } from "next/dist/lib/metadata/resolvers/resolve-opengraph";
import ts from "typescript";
import { baseOpenGraph, baseTwitter, withSocialMetadata } from "../lib/seo";

const appDirectory = join(import.meta.dir, "../app");
const context = { trailingSlash: false, isStaticMetadataRouteFile: false };

function pageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? pageFiles(path) : entry.name === "page.tsx" ? [path] : [];
  }).sort();
}

function readMetadata(path: string, helper = withSocialMetadata): Metadata {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(source) !== "metadata" || !declaration.initializer) continue;
      return new Function("baseOpenGraph", "baseTwitter", "withSocialMetadata", `return (${declaration.initializer.getText(source)});`)(baseOpenGraph, baseTwitter, helper);
    }
  }
  throw new Error(`Missing metadata export: ${path}`);
}

function nonSocial({ openGraph, twitter, ...metadata }: Metadata): Metadata {
  return metadata;
}

const root = readMetadata(join(appDirectory, "layout.tsx"));
const pages = pageFiles(appDirectory);

async function resolveSocial(metadata: Metadata, path: string) {
  return {
    openGraph: await resolveOpenGraph(metadata.openGraph, root.metadataBase ?? null, Promise.resolve(path), context, null),
    twitter: resolveTwitter(metadata.twitter, root.metadataBase ?? null, context, null)
  };
}

function expectImages(social: Awaited<ReturnType<typeof resolveSocial>>) {
  for (const metadata of [social.openGraph, social.twitter]) {
    expect(metadata?.images).toHaveLength(1);
    const image = metadata?.images?.[0];
    expect(image).toMatchObject({
      width: 1200,
      height: 630,
      alt: "OpenWork — Your AI workspace. Without vendor lock-in."
    });
    expect(typeof image === "object" && "url" in image && image.url.toString()).toBe("https://openworklabs.com/openwork-social.png");
  }
  expect(social.twitter).toMatchObject({ card: "summary_large_image" });
  expect(social.openGraph).toMatchObject({ type: "website", siteName: "OpenWork", locale: "en_US" });
}

describe("Landing social metadata", () => {
  test("covers all 20 real HTML routes", () => {
    expect(pages.map((path) => relative(appDirectory, path))).toEqual([
      "alternatives/claude-cowork/page.tsx", "cloud/page.tsx", "connect/page.tsx", "contact/page.tsx", "dashboard/page.tsx",
      "docs/roadmap/page.tsx", "docs/start-here/migrate-from-claude-cowork/page.tsx",
      "download/page.tsx", "enterprise/page.tsx", "feedback/page.tsx", "glm-5.2/page.tsx",
      "og/page.tsx", "page.tsx", "pricing/page.tsx", "privacy/page.tsx", "roadmap/page.tsx",
      "starter-success/page.tsx", "terms/page.tsx", "terms/subscription/page.tsx", "trust/page.tsx"
    ]);
  });

  test("uses the supplied local PNG at its native dimensions", () => {
    const path = join(import.meta.dir, "../public/openwork-social.png");
    const image = readFileSync(path);
    expect(statSync(path).size).toBe(656195);
    expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(image.toString("ascii", 12, 16)).toBe("IHDR");
    expect(image.readUInt32BE(16)).toBe(1200);
    expect(image.readUInt32BE(20)).toBe(630);
  });

  test("root supplies image fallbacks without hardcoding social text", async () => {
    expect(root.metadataBase?.toString()).toBe("https://openworklabs.com/");
    expect(root.openGraph?.title).toBeUndefined();
    expect(root.openGraph?.description).toBeUndefined();
    expect(root.twitter?.title).toBeUndefined();
    expect(root.twitter?.description).toBeUndefined();
    expectImages(await resolveSocial(root, "/"));
  });

  for (const path of pages) {
    const route = `/${relative(appDirectory, path).replace(/(^|\/)page\.tsx$/, "")}`;
    test(`${route} replaces inherited social objects with complete page-specific metadata`, async () => {
      const input = readMetadata(path, (metadata) => metadata);
      const page = readMetadata(path);
      const social = await resolveSocial({ ...root, ...page }, route);
      const title = input.openGraph?.title ?? input.title;
      const description = input.openGraph?.description ?? input.description;

      expect(typeof title).toBe("string");
      expect(typeof description).toBe("string");
      expect(String(title).length).toBeGreaterThan(0);
      expect(String(description).length).toBeGreaterThan(0);
      expect(social.openGraph).toMatchObject({ title: { absolute: title }, description });
      expect(social.twitter).toMatchObject({
        title: { absolute: input.twitter?.title ?? title },
        description: input.twitter?.description ?? description
      });
      expect(page.openGraph?.url).toBe(input.openGraph?.url);
      expect(nonSocial(page)).toEqual(nonSocial(input));
      if (route !== "/") expect(title).not.toBe(root.title);
      expectImages(social);
    });
  }

  test("/og adds only social fields, retaining inherited ordinary metadata", () => {
    const page = readMetadata(join(appDirectory, "og/page.tsx"));
    expect(Object.keys(page).sort()).toEqual(["openGraph", "twitter"]);
    expect(nonSocial({ ...root, ...page })).toEqual(nonSocial(root));
  });

  test("preserves authored roadmap and migration social overrides", () => {
    for (const path of ["roadmap/page.tsx", "docs/roadmap/page.tsx"]) {
      const metadata = readMetadata(join(appDirectory, path));
      expect(metadata.openGraph?.title).toBe("OpenWork Roadmap | Your workspace, on every surface");
      expect(metadata.openGraph?.description).toBe("The roadmap for the OpenWork desktop app, portable agent capabilities, hosted workspaces, and every surface where work happens.");
      expect(metadata.openGraph?.url).toBe("https://openworklabs.com/roadmap");
      expect(metadata.alternates?.canonical).toBe("/roadmap");
    }
    const migration = readMetadata(join(appDirectory, "docs/start-here/migrate-from-claude-cowork/page.tsx"));
    expect(migration.openGraph?.description).toBe("A step-by-step guide to moving your Cowork setup to open-source OpenWork.");
    expect(migration.twitter?.description).toBe(migration.openGraph?.description);
  });

  test("preserves every provided non-social field and does not mutate the input", () => {
    const input: Metadata = {
      metadataBase: new URL("https://openworklabs.com"),
      title: { absolute: "HTML title", template: "%s | HTML" },
      description: "HTML description",
      alternates: { canonical: "/feedback", languages: { en: "/feedback" } },
      robots: { index: false, follow: true, googleBot: { index: false } },
      keywords: ["OpenWork"],
      authors: [{ name: "OpenWork" }],
      icons: { icon: "/favicon.ico" },
      manifest: "/manifest.webmanifest",
      verification: { google: "verification-value" },
      other: { "custom-meta": "unchanged" },
      openGraph: { title: "Authored OG title", description: "Authored OG description", url: "/roadmap" },
      twitter: { title: "Authored Twitter title", description: "Authored Twitter description", site: "@openwork" }
    };
    const before = JSON.stringify(input);
    const result = withSocialMetadata(Object.freeze(input));
    expect(nonSocial(result)).toEqual(nonSocial(input));
    expect(result.alternates).toBe(input.alternates);
    expect(result.robots).toBe(input.robots);
    expect(result.title).toBe(input.title);
    expect(result.openGraph?.title).toBe("Authored OG title");
    expect(result.openGraph?.description).toBe("Authored OG description");
    expect(result.openGraph?.url).toBe("/roadmap");
    expect(result.twitter).toMatchObject({ title: "Authored Twitter title", description: "Authored Twitter description", site: "@openwork" });
    expect(JSON.stringify(input)).toBe(before);
  });

  test("fills each absent social text field independently from ordinary metadata", () => {
    const result = withSocialMetadata({
      title: "Page title",
      description: "Page description",
      openGraph: { title: "OG title" },
      twitter: { description: "Twitter description" }
    });
    expect(result.openGraph).toMatchObject({ title: "OG title", description: "Page description" });
    expect(result.twitter).toMatchObject({ title: "OG title", description: "Twitter description" });
  });
});

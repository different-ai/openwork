import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CoworkerPage, { metadata } from "../app/coworker/page";
import CoworkerDownloadPage, { metadata as downloadMetadata } from "../app/coworker/download/page";
import { alt as socialAlt } from "../app/coworker/opengraph-image";
import { CoworkerAppIcon, CoworkerAvatar, CoworkerMark, GroupAvatars } from "../components/coworker-brand";
import { StaticCoworkerAvatar, type AvatarColor, type AvatarGlasses } from "@openwork/ui/coworker-artwork";
import { SiteFooter } from "../components/site-footer";
import { BENEFITS, COLLABORATION, COWORKER, FAQ, FORBIDDEN_PHRASES, GET_STARTED, HERO, MODELS, OPENWORK, POWERED_BY, STEPS, WORK_EXAMPLES, allClaims } from "../lib/coworker-content";

const html = renderToStaticMarkup(createElement(CoworkerPage));
describe("/coworker announcement", () => {
  test("leads with customer value and a truthful alpha download action", () => {
    const heading = html.match(/<h1\b[^>]*>(.*?)<\/h1>/s)?.[1]?.replace(/<[^>]+>/g, "");
    expect(heading).toBe("Your AI team. Built to work together.");
    expect(heading).toBe(HERO.title);
    expect(metadata.title).toBe(`Open Coworker — ${HERO.title}`);
    expect(metadata.openGraph?.title).toBe(`Open Coworker — ${HERO.title}`);
    expect(socialAlt).toBe(`Open Coworker — ${HERO.title}`);
    expect(html).not.toContain("A little help with the research");
    expect(html).toContain(HERO.lead);
    expect(HERO.lead).toContain("their own roles, memory, and responsibilities");
    expect(html).not.toContain('class="cw-nav');
    expect(html.match(/<section id="top".*?<\/section>/s)?.[0]).not.toMatch(/computer use/i);
    expect(html.indexOf('id="team"')).toBeLessThan(html.indexOf('id="possibilities"'));
    expect(html.indexOf('data-testid="coworker-benefits"')).toBeLessThan(html.indexOf('id="possibilities"'));
    expect(html.indexOf('id="openwork"')).toBeLessThan(html.indexOf('id="possibilities"'));
    expect(html).toContain('data-feature="templates"');
    expect(html).toContain('aria-label="Computer use"');
    expect(html).not.toContain('data-testid="computer-preview-status"');
    expect(HERO.primary).toEqual({ label: "Download alpha", href: "/coworker/download" });
    expect(html).toContain('<a href="/coworker/download"');
    expect(html).toContain("Download alpha");
    expect(html).toContain("macOS alpha available · Apple Silicon · Signed and notarized");
    expect(html).not.toContain("Public download coming soon.");
    expect(html).toContain(GET_STARTED.status);
    expect(html).not.toContain("Run it from");
    expect(metadata.description).toBe(HERO.lead);
    for (const phrase of FORBIDDEN_PHRASES) expect(html.toLowerCase()).not.toContain(phrase);
  });
  test("renders every benefit, step, and expandable answer with product sources kept out of view", () => {
    for (const item of [...BENEFITS, ...STEPS, ...OPENWORK.items]) expect(html).toContain(item.title);
    expect(html).toContain(COLLABORATION.text);
    expect(html).toContain(OPENWORK.title);
    expect(html).toContain(OPENWORK.lead.text);
    expect(html).toContain(OPENWORK.note);
    expect(html).toContain('href="' + OPENWORK.cta.href + '"');
    expect(html).toContain('id="openwork"');
    for (const benefit of BENEFITS) {
      expect(html).toContain(benefit.preview.label);
      expect(html).toContain(benefit.preview.title);
      expect(html).toContain(benefit.preview.detail);
    }
    for (const example of WORK_EXAMPLES) expect(html).toContain(example.label.replaceAll("&", "&amp;"));
    expect(html).toContain("Illustrative examples · No live connections or runs");
    expect(html).toContain(WORK_EXAMPLES[0]!.result);
    expect(html).not.toContain(WORK_EXAMPLES[1]!.result);
    for (const item of FAQ) expect(html).toContain(item.question);
    expect((html.match(/<details/g) ?? []).length).toBe(FAQ.length);
    for (const claim of allClaims()) {
      expect(claim.text.length).toBeGreaterThan(20);
      expect(claim.source).toMatch(/apps\/|packages\//);
      expect(html).not.toContain(claim.source);
    }
  });
  test("routes prospects and members to Models with campaign and auth intent intact", () => {
    for (const [href, mode, content] of [[MODELS.cta.href, "sign-up", "models"], [MODELS.member.href, "sign-in", "member"]]) {
      const url = new URL(href!);
      expect(url.origin).toBe("https://app.openworklabs.com");
      expect(url.searchParams.get("mode")).toBe(mode!);
      expect(url.searchParams.get("intent")).toBe("models");
      expect(url.searchParams.get("utm_campaign")).toBe("coworker");
      expect(url.searchParams.get("utm_content")).toBe(content!);
      expect(url.searchParams.has("token")).toBe(false);
    }
    expect(html).toContain(MODELS.cta.label);
    expect(html).toContain(MODELS.member.label);
    expect(html).toContain(MODELS.note);
  });
  test("gives early-access requests a real destination without pretending to register anyone", () => {
    expect(html).toContain('href="mailto:team@openworklabs.com?subject=Open%20Coworker%20early%20access"');
    expect(html).toContain("Email for early access");
    expect(html).toContain("Opens your email app");
    expect(html).toContain(COWORKER.app);
    expect(html).not.toContain("You’re on the list");
    expect(html).not.toContain('type="email"');
  });
  test("offers only the pinned Apple Silicon alpha with its release warning", () => {
    const download = renderToStaticMarkup(createElement(CoworkerDownloadPage));
    const hrefs = [...download.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => match[1]!);
    const installer = "https://github.com/different-ai/openwork/releases/download/coworker-v0.1.0-alpha.20260908.1/open-coworker-mac-arm64-0.1.0-alpha.20260908.1.dmg";
    expect(downloadMetadata.alternates?.canonical).toBe("/coworker/download");
    expect(download).toContain("Open Coworker for Mac.");
    expect(download).toContain("For Apple Silicon Macs");
    expect(download).toContain("DMG / 274 MB / arm64");
    expect(download).toContain("0.1.0-alpha.20260908.1");
    expect(hrefs.filter((href) => href.includes("/releases/download/") || /\.(dmg|exe|msi|zip|deb|rpm|appimage|gz)$/i.test(href))).toEqual([installer]);
    expect(download).toMatch(/<a\b[^>]*aria-describedby="download-alpha-warning"[^>]*>.*?Download macOS alpha<\/a>/s);
    expect(hrefs).toContain("https://github.com/different-ai/openwork/releases/tag/coworker-v0.1.0-alpha.20260908.1");
    expect(download).toContain('id="download-alpha-warning"');
    expect(download).toContain("An early testing build, not a stable release.");
    expect(download).toContain("This release is signed and notarized.");
    for (const platform of ["Mac with Intel", "Windows", "Linux"]) expect(download).toContain(`<dt>${platform}</dt><dd>Not available</dd>`);
    expect(download).toContain("Native computer-control verification remains incomplete. Remote computers are not available.");
    expect(download).toContain("is not required to download this alpha.");
    expect(hrefs).toContain(COWORKER.app);
    expect(hrefs).toContain("/coworker#how");
    expect(download).toContain('src="/coworker/app-icon.png"');
    expect(downloadMetadata.icons).toEqual({ icon: "/coworker/app-icon.png", apple: "/coworker/app-icon.png" });
  });
  test("distinguishes local work, cloud schedules, and optional paid models", () => {
    expect(html).toContain("while Open Coworker is open");
    expect(html).toContain("cannot read your coworker&#x27;s local files or memory today");
    expect(html).toContain("optional paid membership");
    expect(html).toContain("Sample data and scripted replies.");
    expect(html).toContain("How’s the launch brief coming along?");
    expect(html).toContain("Launch brief");
    expect(html).not.toContain("1 Worker running");
    expect(html).not.toContain("Saved a working note");
  });
  test("keeps the page accessible and uses existing OpenWork identity", () => {
    expect(html).toContain("Skip to content");
    expect(html).not.toContain('aria-label="Primary"');
    expect(html).toContain('data-placement="hero"');
    expect(html).toContain('data-coworker-mark="white"');
    expect(html).toContain('aria-label="Footer"');
    expect(html).toContain(POWERED_BY);
    expect(html).toContain('src="/openwork-mark.svg"');
    for (const href of ["/docs", "/pricing", "/enterprise", "/"]) expect(html).toContain('href="' + href + '"');
    expect(renderToStaticMarkup(createElement(SiteFooter))).toContain('href="/coworker"');
  });
  test("keeps the white website logo separate from the download icon and coworker palettes", () => {
    const mark = renderToStaticMarkup(createElement(CoworkerMark, { size: 30, label: "Open Coworker" }));
    expect(mark).toContain("<svg");
    expect(mark).toContain('fill="#f7f8fa"');
    expect(mark).toContain('aria-label="Open Coworker"');
    expect(mark).not.toContain("<img");
    expect(html).toContain('data-coworker-mark="white"');
    expect(html).not.toContain("/coworker/app-icon.png");
    expect(metadata.icons).toBeUndefined();
    const appIcon = renderToStaticMarkup(createElement(CoworkerAppIcon, { label: "Open Coworker app" }));
    expect(appIcon).toContain('<img src="/coworker/app-icon.png"');
    expect(appIcon).toContain('alt="Open Coworker app"');
    const avatar = renderToStaticMarkup(createElement(CoworkerAvatar, { name: "Editor", color: "rose", glasses: "square" }));
    expect(avatar).toContain('aria-label="Editor avatar"');
    expect(avatar).toContain("#e2c1cb");
    const palettes: Record<AvatarColor, string> = { blue: "#b8c9f0", violet: "#c8c1e2", mint: "#b2d5cb", orange: "#e4c3ad", rose: "#e2c1cb", slate: "#e3e6ea", sand: "#ded0b0", sage: "#becab4" };
    const glasses: AvatarGlasses[] = ["round", "square", "oval", "none", "sunglasses", "monocle"];
    for (const color of Object.keys(palettes) as AvatarColor[]) for (const style of glasses) for (const size of [22, 96]) {
      const props = { name: "Editor", identity: "editor", color, glasses: style, size, animated: false };
      const staticArt = renderToStaticMarkup(createElement(StaticCoworkerAvatar, props));
      expect(renderToStaticMarkup(createElement(CoworkerAvatar, props))).toBe(staticArt);
      expect(staticArt).toContain(palettes[color]);
      expect(staticArt).toContain('data-identity="editor"');
      expect(staticArt.includes('class="coworker-avatar__monocle-chain"')).toBe(style === "monocle" && size > 36);
      if (style === "sunglasses") expect(staticArt).toContain('fill-opacity="0.24"');
    }
  });
  test("group artwork keeps up to three separate identities with a count beyond them", () => {
    for (const count of [2, 3, 4]) for (const size of [18, 22, 30]) {
      const members = Array.from({ length: count }, (_, index) => ({ slug: `member-${index}`, name: `Member ${index}`, avatarColor: "blue", avatarGlasses: "round" } satisfies Parameters<typeof GroupAvatars>[0]["members"][number]));
      const group = renderToStaticMarkup(createElement(GroupAvatars, { members, size, animated: false, activeSlugs: ["member-1"] }));
      expect(group).toContain(`data-count="${count}"`);
      expect((group.match(/data-testid="coworker-avatar"/g) ?? []).length).toBe(Math.min(count, 3));
      expect((group.match(/data-active="true"/g) ?? []).length).toBe(1);
      expect(group).toContain(`left:${Math.round(size * 0.94)}px`);
      expect(group.includes('coworker-avatar-group__extra')).toBe(count > 3);
      expect(group).not.toContain('data-identity="member-3"');
      if (count > 3) expect(group).toContain("+1</span>");
    }
  });
});

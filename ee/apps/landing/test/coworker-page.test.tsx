import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CoworkerPage, { metadata } from "../app/coworker/page";
import { CoworkerAvatar, CoworkerMark, GroupAvatars } from "../components/coworker-brand";
import { StaticCoworkerAvatar, type AvatarColor, type AvatarGlasses } from "@openwork/ui/coworker-artwork";
import { SiteFooter } from "../components/site-footer";
import { BENEFITS, COWORKER, FAQ, FORBIDDEN_PHRASES, GET_STARTED, HERO, MODELS, POWERED_BY, STEPS, allClaims } from "../lib/coworker-content";

const html = renderToStaticMarkup(createElement(CoworkerPage));
describe("/coworker announcement", () => {
  test("leads with customer value and a truthful early-access action", () => {
    expect(html).toContain("Your work.");
    expect(html).toContain("Better together.");
    expect(html).not.toContain("A coworker who remembers");
    expect(html).toContain(HERO.lead);
    expect(html).toContain("Get early access");
    expect(html).toContain(GET_STARTED.status);
    expect(html).not.toContain("Run it from");
    expect(metadata.description).toBe(HERO.lead);
    for (const phrase of FORBIDDEN_PHRASES) expect(html.toLowerCase()).not.toContain(phrase);
  });
  test("renders every benefit, step, and expandable answer with product sources kept out of view", () => {
    for (const item of [...BENEFITS, ...STEPS]) expect(html).toContain(item.title);
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
    expect(html).toContain("Opens your email app");
    expect(html).toContain(COWORKER.app);
    expect(html).not.toContain("You’re on the list");
    expect(html).not.toContain('type="email"');
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
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('aria-label="Footer"');
    expect(html).toContain(POWERED_BY);
    expect(html).toContain('src="/openwork-mark.svg"');
    for (const href of ["/docs", "/pricing", "/enterprise", "/"]) expect(html).toContain('href="' + href + '"');
    expect(renderToStaticMarkup(createElement(SiteFooter))).toContain('href="/coworker"');
  });
  test("renders the existing brand mark and coworker palettes", () => {
    expect(renderToStaticMarkup(createElement(CoworkerMark, { size: 30, label: "Open Coworker" }))).toContain('aria-label="Open Coworker"');
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

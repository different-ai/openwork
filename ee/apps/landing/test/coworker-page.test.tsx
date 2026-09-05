import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CoworkerPage, { metadata } from "../app/coworker/page";
import { CoworkerAvatar, CoworkerMark } from "../components/coworker-brand";
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
  });
});

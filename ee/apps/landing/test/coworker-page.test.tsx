import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CoworkerAvatar, CoworkerMark } from "../components/coworker-brand";
import { CoworkerVignette, TEAM } from "../components/coworker-vignette";
import { SiteFooter } from "../components/site-footer";
import {
  AGENT,
  CLOUD,
  COWORKER,
  FORBIDDEN_PHRASES,
  GET_STARTED,
  HERO,
  MEMORY,
  PLACEMENTS,
  STEPS,
  TEAM as TEAM_COPY,
  WITH_OPENWORK,
  allClaims
} from "../lib/coworker-content";

const root = join(import.meta.dir, "..");

describe("/coworker copy", () => {
  test("every product claim names where in the product it is true", () => {
    const claims = allClaims();
    expect(claims.length).toBeGreaterThanOrEqual(14);
    for (const claim of claims) {
      expect(claim.text.trim().length, `claim is too thin: ${claim.text}`).toBeGreaterThan(20);
      if (claim.planned) {
        expect(claim.source, `a planned statement must be sourced to the product plan: ${claim.text}`).toMatch(/^plans\//);
        expect(claim.text, `a planned statement must read as direction, not as shipped: ${claim.text}`).toMatch(/direction|toward|next|over time/i);
        continue;
      }
      expect(claim.source, `claim needs a product source, got "${claim.source}" for: ${claim.text}`).toMatch(
        /(apps\/coworker|packages\/|ee\/apps\/den-api|ee\/apps\/landing\/app\/pricing|@openwork\/)/
      );
    }
  });

  test("only one statement on the page is about direction, and it says so", () => {
    const planned = allClaims().filter((claim) => claim.planned);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.text).toMatch(/today a coworker lives on your Mac/);
  });

  test("copy never promises what the product cannot do, and never sells against OpenWork", () => {
    const everything = JSON.stringify({ HERO, WITH_OPENWORK, STEPS, MEMORY, TEAM_COPY, PLACEMENTS, CLOUD, GET_STARTED, AGENT }).toLowerCase();
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(everything.includes(phrase), `forbidden phrase present: "${phrase}"`).toBe(false);
    }
    // A complement, said so: the page names OpenWork as the platform underneath, in the hero and the comparison.
    expect(HERO.lead).toMatch(/OpenWork/);
    expect(WITH_OPENWORK.lead).toMatch(/nothing is duplicated underneath/i);
    expect(WITH_OPENWORK.rows.length).toBeGreaterThanOrEqual(4);
  });

  test("placement copy keeps local and cloud promises distinct and truthful", () => {
    const local = PLACEMENTS.items.find((item) => item.name === "This Mac");
    const cloud = PLACEMENTS.items.find((item) => item.name === "OpenWork Cloud");
    expect(local && cloud).toBeTruthy();
    expect(local!.points.join(" ")).toMatch(/while Open Coworker is open/);
    expect(local!.points.join(" ")).toMatch(/recovered once on launch/);
    expect(cloud!.points.join(" ")).toMatch(/even when your Mac is off/);
    expect(cloud!.points.join(" ")).toMatch(/Cannot read the coworker's local files or memory/);
    expect(CLOUD.cloud.cta.href.startsWith("https://app.openworklabs.com?mode=sign-up")).toBe(true);
    expect(CLOUD.cloud.cta.href).toContain("utm_campaign=coworker");
    expect(CLOUD.cloud.secondary.href).toBe("/pricing");
    expect(CLOUD.teams.cta.href).toBe("/enterprise");
  });

  test("get-started is honest about distribution and points at the real repository", () => {
    expect(GET_STARTED.status).toMatch(/no signed download yet/);
    expect(GET_STARTED.commands.some((command) => command.includes("@openwork/coworker dev"))).toBe(true);
    expect(GET_STARTED.commands[0]).toBe(`git clone ${COWORKER.repository}`);
  });

  test("the agent resources the page links to exist on this site and agree with it", () => {
    for (const link of AGENT.links) {
      const file = join(root, "public", link.href);
      expect(existsSync(file), `${link.href} must be served from public/`).toBe(true);
    }
    const start = readFileSync(join(root, "public", "coworker", "start.md"), "utf8");
    expect(start).toMatch(/Use this Mac/);
    expect(start).not.toMatch(/Start locally/);
    expect(start).toMatch(/no signed download yet/i);
    for (const command of GET_STARTED.commands) expect(start).toContain(command);
    const llms = readFileSync(join(root, "public", "llms.txt"), "utf8");
    expect(llms).toContain("## Open Coworker");
    expect(llms).toContain("https://openworklabs.com/coworker/start.md");
    expect(AGENT.promptTemplate("https://openworklabs.com/coworker/start.md")).toMatch(/Use this Mac/);
    expect(existsSync(join(root, "public", "coworker", "og.png"))).toBe(true);
  });
});

describe("/coworker visuals", () => {
  test("the brand mark and avatars render as accessible SVG in the app's palettes", () => {
    const mark = renderToStaticMarkup(createElement(CoworkerMark, { size: 30, label: "Open Coworker" }));
    expect(mark).toContain('role="img"');
    expect(mark).toContain('aria-label="Open Coworker"');
    expect(mark).toContain("#f7f8fa");
    const avatar = renderToStaticMarkup(createElement(CoworkerAvatar, { name: "Editor", color: "rose", glasses: "square" }));
    expect(avatar).toContain('aria-label="Editor avatar"');
    expect(avatar).toContain("#e2c1cb");
    expect(avatar).toContain("<rect");
  });

  test("the vignette shows the app's own states and vocabulary, never a feature it lacks", () => {
    const html = renderToStaticMarkup(createElement(CoworkerVignette));
    expect(TEAM.map((member) => member.label)).toEqual(["Working", "Needs you", "Ready"]);
    for (const member of TEAM) expect(html).toContain(member.name);
    for (const phrase of ["Coworkers", "Activity", "Thought through", "Documents", "Workers", "Assignments", "Message Scout", "Enter sends it next"]) {
      expect(html).toContain(phrase);
    }
    for (const phrase of ["Response delayed", "could not reply", "engine", "MCP", "session"]) {
      expect(html.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });

  test("the site links to /coworker from its footer", () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    expect(html).toContain('href="/coworker"');
  });
});

import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
mock.module("../lib/github", () => ({ getGithubData: async () => ({ stars: "23k" }) }));

const { LpProductsShowcase } = await import("../components/lp-products-showcase");
const { LpConnectConsole } = await import("../components/lp-connect-console");
const { MCP_CLIENTS, CURSOR_INSTALL_LINK, VS_CODE_INSTALL_LINK } = await import("../components/lp-mcp-clients");
const { default: ConnectPage } = await import("../app/connect/page");

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const URL = "https://api.openworklabs.com/mcp/agent";

describe("Homepage products showcase", () => {
  test("offers four product tabs with the Desktop App preview selected first", () => {
    const html = renderToStaticMarkup(createElement(LpProductsShowcase));
    const tabs = [...html.matchAll(/role="tab"[^>]*aria-selected="(true|false)"[^>]*>([\s\S]*?)<\/button>/g)].map(
      (match) => ({ selected: match[1] === "true", label: text(match[2]) })
    );
    expect(tabs.map((tab) => tab.label.trim().split(" ").slice(0, 2).join(" "))).toEqual([
      "Desktop App",
      "MCP Gateway",
      "AI Gateway",
      "Cloud App"
    ]);
    expect(tabs.filter((tab) => tab.selected).map((tab) => tab.label)).toHaveLength(1);
    expect(tabs[0].selected).toBe(true);
    expect(html).toContain('role="tabpanel"');
    // The preview is the real app layout: sidebar views and a chat turn with an approval.
    expect(text(html)).toContain("Automations");
    expect(text(html)).toContain("Library");
    expect(text(html)).toContain("Post weekly-update.md to #launch?");
  });

  test("leads with the open-source app and the free team tier, without folder labels", () => {
    const body = text(renderToStaticMarkup(createElement(LpProductsShowcase)));
    expect(body).toContain("Start with the open-source app. Add the rest when you need it.");
    expect(body).toContain("Free for teams of up to 5.");
    expect(body).not.toContain("~/Marketing");
    expect(body).not.toContain("Cloud computer ");
  });

  test("uses no dark panel surfaces", () => {
    const html = renderToStaticMarkup(createElement(LpProductsShowcase));
    expect(html).not.toContain("lp-terminal");
    expect(html).not.toContain("#0b1e30");
  });
});

describe("MCP Gateway page", () => {
  test("leads with the URL, the free solo tier and a copy action", async () => {
    const html = renderToStaticMarkup(await ConnectPage());
    const body = text(html);
    expect(body).toContain("Add one URL. Use your MCPs in every app.");
    expect(body).toContain("Free for solo use");
    expect(body).toContain(URL);
    expect(body).toContain("Copy URL");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  test("explains how skill sharing works through the gateway", async () => {
    const body = text(renderToStaticMarkup(await ConnectPage()));
    expect(body).toContain("Share a skill once. Every agent on your team can use it.");
    expect(body).toContain("Loaded when it's needed");
    expect(body).toContain("Edits reach everyone");
    expect(body).toContain("Access checked on every call");
    expect(body).toContain("First 5 seats free");
  });

  test("console shows the exact Claude Code command first and lists every client", () => {
    const html = renderToStaticMarkup(createElement(LpConnectConsole));
    expect(text(html)).toContain(`claude mcp add --transport http openwork ${URL}`);
    const tabs = [...html.matchAll(/role="tab"/g)];
    expect(tabs).toHaveLength(MCP_CLIENTS.length);
  });

  test("one-click links match the ones published in the docs", () => {
    expect(CURSOR_INSTALL_LINK).toStartWith("cursor://anysphere.cursor-deeplink/mcp/install?name=openwork&config=");
    const config = JSON.parse(atob(CURSOR_INSTALL_LINK.split("config=")[1]));
    expect(config).toEqual({ url: URL });
    const vscode = JSON.parse(decodeURIComponent(VS_CODE_INSTALL_LINK.replace("vscode:mcp/install?", "")));
    expect(vscode).toEqual({ name: "openwork", type: "http", url: URL });
  });
});

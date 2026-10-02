import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { toolsRecipe } from "../src/build-recipes.ts";
import { snapshotSlug, type PreviewWorld } from "../src/index.ts";

const worlds: PreviewWorld[] = ["desktop", "acme-web", "app-web"];
for (const world of worlds) {
  test(`${world} tools recipe parses and provisions a browser only for desktop worlds`, () => {
    const recipe = toolsRecipe(world);
    execFileSync("bash", ["-n"], { input: recipe });
    assert.equal(recipe.includes("google-chrome-stable"), world !== "app-web");
    if (world !== "app-web") {
      assert.ok(recipe.includes('"${OPENWORK_PREVIEW_BROWSER_PROFILE:-${XDG_CONFIG_HOME:-$HOME/.config}/openwork-preview-browser}"'));
      assert.match(recipe, /X-XFCE-CommandsWithParameter=.*"%s"/);
      assert.match(recipe, /x-scheme-handler\/https=openwork-preview-browser.desktop/);
    }
  });
}

test("old browserless desktop snapshots cannot satisfy the new image version", () => {
  const sha = "a".repeat(40);
  assert.equal(snapshotSlug(sha, "app-web"), `openwork-app-web-v6-${sha}`);
  assert.equal(snapshotSlug(sha, "desktop"), `openwork-desktop-v7-${sha}`);
  assert.equal(snapshotSlug(sha, "acme-web"), `openwork-acme-web-v7-${sha}`);
});

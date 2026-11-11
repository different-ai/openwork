import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getFeatureIntro } from "./index";
import { getOrgAccessFlags } from "../../../../_lib/den-org";
import { computersIntros } from "./computers";

test("Computers registers its Den route, live example, docs and truthful Desktop action", () => {
  const intro = getFeatureIntro("computers");
  assert.ok(intro);
  assert.equal(intro.match.path, "/dashboard/computers");
  assert.equal(intro.ctas.at(-1)?.href, "openwork://open");
  assert.match(intro.body ?? "", /does not provision a machine or grant remote access/);
  assert.match(intro.body ?? "", /OpenWork instances/);
  assert.ok(intro.docsUrl.startsWith("https://"));
  assert.ok(intro.example);
  const Example = intro.example.Component;
  const html = renderToStaticMarkup(<Example />);
  // The example is the page's own rows: a tile, a name over what it is, then owner and status lanes.
  assert.match(html, /role="table"/);
  assert.doesNotMatch(html, /<table|<button|<a /);
  assert.match(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), /Computer Owner Status Design laptop Mac A Alex Online Research computer Workbot(&#x27;|')s computer S Sam Paused/);
  assert.doesNotMatch(html, /<img|<video|<iframe/);
  assert.equal(computersIntros.length, 2);
  assert.ok(getOrgAccessFlags("admin", false).canViewComputers);
});

test("My Computers has its own intro for every member, with no permission lock and no promise of access", () => {
  const intro = getFeatureIntro("my-computers");
  assert.ok(intro);
  assert.equal(intro.match.path, "/dashboard/my-computers");
  assert.equal(intro.ctas.length, 1);
  assert.equal(intro.ctas[0]?.locked, undefined);
  assert.match(intro.body ?? "", /does not start a computer or grant access/);
  assert.ok(intro.example);
  const Example = intro.example.Component;
  const text = renderToStaticMarkup(<Example />).replace(/<[^>]+>/g, " ");
  assert.match(text.replace(/\s+/g, " "), /Work laptop Mac Online Research computer Shared with your organization Not checked yet/);
});

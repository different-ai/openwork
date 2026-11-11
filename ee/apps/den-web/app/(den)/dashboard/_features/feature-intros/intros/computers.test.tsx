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
  assert.match(html, /<table/);
  assert.match(html, /Alex|Sam/);
  assert.doesNotMatch(html, /<img|<video|<iframe/);
  assert.equal(computersIntros.length, 1);
  assert.ok(getOrgAccessFlags("admin", false).canViewComputers);
});

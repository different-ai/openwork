import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getOrgAccessFlags, parseOrgContextPayload } from "../../../../_lib/den-org";
import { matchFeatureIntro, selectIntroSize } from "../model";
import type { FeatureIntroContext, FeatureIntroFacts } from "../types";
import { FEATURE_INTROS, getFeatureIntro } from "./index";

function ctx(facts: FeatureIntroFacts): FeatureIntroContext {
  const orgContext = parseOrgContextPayload({
    organization: { id: "org_1", name: "Acme", slug: "acme" },
    currentMember: { id: "member_1", userId: "user_1", role: "member", isOwner: false },
  });
  assert.ok(orgContext);
  return { orgId: "org_1", orgSlug: "acme", orgContext, access: getOrgAccessFlags("member", false), isAdmin: false, can: () => false, memberName: () => null, facts };
}

test("My Sessions has an intro for every member that never promises access", () => {
  const intro = getFeatureIntro("my-sessions");
  assert.ok(intro);
  assert.equal(intro.match.path, "/dashboard/my-sessions");
  assert.equal(matchFeatureIntro(FEATURE_INTROS, "/dashboard/my-sessions", null)?.key, "my-sessions");
  assert.equal(matchFeatureIntro(FEATURE_INTROS, "/dashboard/my-sessions", new URLSearchParams("session=cmd_1"))?.key, "my-sessions");
  assert.equal(matchFeatureIntro(FEATURE_INTROS, "/dashboard/my-computers", null)?.key, "my-computers");
  assert.equal(intro.ctas.length, 1);
  assert.equal(intro.ctas[0]?.locked, undefined);
  assert.ok(intro.docsUrl.startsWith("https://"));
  const words = `${intro.summary} ${intro.body ?? ""}`;
  assert.match(words, /Tasks you start on another computer show up here/);
  assert.match(words, /appear once that computer allows all sessions/);
  assert.doesNotMatch(words, /grant|gives? (you )?access|turn(s)? on/i);
  assert.ok(intro.example);
  const Example = intro.example.Component;
  const html = renderToStaticMarkup(<Example />);
  // The example is the page's own rows: a title over where it runs, then its state as a dot and a word.
  assert.match(html, /role="table"/);
  assert.doesNotMatch(html, /<table|<button/);
  assert.match(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), /Update the release notes Work laptop Needs you Summarize this week(&#x27;|')s tickets Mac mini Working Draft the launch email Work laptop Idle/);
  assert.doesNotMatch(html, /<img|<video|<iframe|<a /);
});

test("the intro takes the list's place only once it loaded with no sessions", () => {
  const intro = getFeatureIntro("my-sessions");
  assert.ok(intro);
  const size = (facts: FeatureIntroFacts) => selectIntroSize({ state: intro.setupState(ctx(facts)), parentState: null })?.size ?? null;
  assert.equal(size({}), null);
  assert.equal(size({ sessions: 0 }), "fullscreen");
  assert.equal(size({ sessions: 3 }), null);
});

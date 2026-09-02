import { expect } from "vitest";
import { test } from "@openwork/testkit";

import {
  flattenSessionRows,
  type SessionListItem,
} from "../../apps/app/src/react-app/domains/session/sidebar/utils";

function session(overrides: Partial<SessionListItem> & { id: string }): SessionListItem {
  return {
    title: overrides.id,
    time: { updated: 1, created: 1 },
    ...overrides,
  };
}

test("subagent sessions stay out of the sidebar even when their parent is archived or not loaded", async ({ evidence }) => {
  // The reported bug: the sidebar filled up with "(@explore subagent)" rows.
  // A child session was only hidden when its parent was also in the loaded
  // list, so children of archived parents (archived rows are partitioned out
  // before the root check) and children whose parent fell outside the
  // session-list page were promoted to root rows.
  const rows = flattenSessionRows(
    [
      session({ id: "root" }),
      session({ id: "archived-parent", time: { updated: 1, created: 1, archived: 1 } }),
      session({ id: "child-of-archived", parentID: "archived-parent" }),
      session({ id: "child-of-unloaded", parentID: "ses_not_in_this_page" }),
    ],
    50,
  );

  expect(rows.map((row) => row.session.id)).toEqual(["root"]);

  evidence.recordAssertionEvidence(
    "Sidebar never promotes a subagent session to a root row",
    "flattenSessionRows drops every session carrying a parentID, including children of archived parents and children whose parent is outside the loaded page; the real root still renders.",
    true,
  );
});

test("children of a loaded, active parent are still hidden and the parent still renders", async ({ evidence }) => {
  // Negative half: tightening the filter must not remove the previously
  // working case or start hiding real roots.
  const rows = flattenSessionRows(
    [
      session({ id: "parent" }),
      session({ id: "child", parentID: "parent" }),
      session({ id: "another-root", parentID: null }),
    ],
    50,
  );

  expect(rows.map((row) => row.session.id)).toEqual(["parent", "another-root"]);

  evidence.recordAssertionEvidence(
    "Root sessions keep rendering after the subagent filter change",
    "Roots with no parentID (undefined or null) render in order, and a child of a loaded parent stays hidden as before.",
    true,
  );
});

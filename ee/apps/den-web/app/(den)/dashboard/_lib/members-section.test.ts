import assert from "node:assert/strict";
import { test } from "node:test";
import { membersSectionRedirect } from "./members-section";

const routes = { teams: "/dashboard/members/teams", roles: "/dashboard/members/roles" };

test("old tab links land on the page that replaced the tab", () => {
  assert.equal(membersSectionRedirect({ section: "members", tab: "teams", editTeam: null, search: "tab=teams" }, routes), "/dashboard/members/teams");
  assert.equal(membersSectionRedirect({ section: "members", tab: "roles", editTeam: null, search: "tab=roles" }, routes), "/dashboard/members/roles");
});

test("an edit-team link keeps the team and other parameters", () => {
  assert.equal(
    membersSectionRedirect({ section: "members", tab: "teams", editTeam: "tem_1", search: "tab=teams&editTeam=tem_1&from=x" }, routes),
    "/dashboard/members/teams?editTeam=tem_1&from=x",
  );
  assert.equal(membersSectionRedirect({ section: "members", tab: null, editTeam: "tem_1", search: "editTeam=tem_1" }, routes), "/dashboard/members/teams?editTeam=tem_1");
});

test("the members page and the new pages stay where they are", () => {
  assert.equal(membersSectionRedirect({ section: "members", tab: null, editTeam: null, search: "" }, routes), null);
  assert.equal(membersSectionRedirect({ section: "members", tab: "members", editTeam: null, search: "tab=members" }, routes), null);
  assert.equal(membersSectionRedirect({ section: "teams", tab: "roles", editTeam: null, search: "tab=roles" }, routes), null);
});

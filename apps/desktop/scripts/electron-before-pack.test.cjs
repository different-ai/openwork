const assert = require("node:assert/strict");
const { test } = require("node:test");
const { signingTeamId, entitlementsForTeam, teamIdFromSubject } = require("./electron-before-pack.cjs");

test("signing selects the requested Apple team and renders its keychain group", () => {
  const identities = '  1) ABC "Developer ID Application: Example (A1B2C3D4E5)"\n  2) DEF "Developer ID Application: Other (Z9Y8X7W6V5)"';
  assert.equal(signingTeamId({ identity: "Developer ID Application: Example (A1B2C3D4E5)", identities }), "A1B2C3D4E5");
  assert.throws(() => signingTeamId({ identity: null, identities }), /Multiple Apple signing teams/);
  const output = entitlementsForTeam("<dict>\n</dict>", "A1B2C3D4E5", "com.differentai.openwork");
  assert.match(output, /A1B2C3D4E5\.com\.differentai\.openwork\.webauthn/);
  assert.equal(entitlementsForTeam("<dict></dict>", null, "com.differentai.openwork"), "<dict></dict>");
  assert.equal(teamIdFromSubject("subject=CN = OpenWork, O = Example, OU = A1B2C3D4E5"), "A1B2C3D4E5");
});

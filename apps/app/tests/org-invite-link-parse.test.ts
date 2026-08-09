import { describe, expect, test } from "bun:test";
import { buildOrgInviteJoinUrl, parseOrgInviteLink } from "../src/app/lib/openwork-links";

const NANOID_TOKEN = "V1StGXR8_Z5jdHi6B-myT";
const TYPEID_TOKEN = "invitation_01jjyv5rmxf9es5t1g0y4tkw2h";

describe("parseOrgInviteLink", () => {
  test("parses the invite email / copy-invite-link URL", () => {
    const parsed = parseOrgInviteLink(`https://app.openworklabs.com/join-org?invite=${NANOID_TOKEN}`);
    expect(parsed).toEqual({
      origin: "https://app.openworklabs.com",
      host: "app.openworklabs.com",
      token: NANOID_TOKEN,
      previewUrl: `https://app.openworklabs.com/api/den/v1/orgs/invitations/preview?id=${NANOID_TOKEN}`,
    });
  });

  test("accepts invitation-id style values, self-hosted origins, and trailing slashes", () => {
    expect(parseOrgInviteLink(`https://den.acme.example/join-org/?invite=${TYPEID_TOKEN}`)).toEqual({
      origin: "https://den.acme.example",
      host: "den.acme.example",
      token: TYPEID_TOKEN,
      previewUrl: `https://den.acme.example/api/den/v1/orgs/invitations/preview?id=${TYPEID_TOKEN}`,
    });
    expect(parseOrgInviteLink(`  https://app.openworklabs.com/join-org?invite=${NANOID_TOKEN}  `)?.token).toBe(NANOID_TOKEN);
  });

  test("allows plain http only for local development hosts", () => {
    expect(parseOrgInviteLink(`http://localhost:3000/join-org?invite=${NANOID_TOKEN}`)?.origin).toBe("http://localhost:3000");
    expect(parseOrgInviteLink(`http://127.0.0.1:8080/join-org?invite=${NANOID_TOKEN}`)?.host).toBe("127.0.0.1:8080");
    expect(parseOrgInviteLink(`http://den.acme.example/join-org?invite=${NANOID_TOKEN}`)).toBeNull();
  });

  test("does not activate on other routes, schemes, or malformed tokens", () => {
    expect(parseOrgInviteLink(`https://app.openworklabs.com/install?token=${NANOID_TOKEN}`)).toBeNull();
    expect(parseOrgInviteLink(`https://app.openworklabs.com/join-organization?invite=${NANOID_TOKEN}`)).toBeNull();
    expect(parseOrgInviteLink("https://app.openworklabs.com/join-org")).toBeNull();
    expect(parseOrgInviteLink("https://app.openworklabs.com/join-org?invite=short")).toBeNull();
    expect(parseOrgInviteLink("https://app.openworklabs.com/join-org?invite=has%20space%20chars")).toBeNull();
    expect(parseOrgInviteLink(`openwork://join-org?invite=${NANOID_TOKEN}`)).toBeNull();
    expect(parseOrgInviteLink("not a url")).toBeNull();
    expect(parseOrgInviteLink("")).toBeNull();
  });
});

describe("buildOrgInviteJoinUrl", () => {
  const link = parseOrgInviteLink(`https://den.acme.example/join-org?invite=${NANOID_TOKEN}`);
  if (!link) throw new Error("fixture invite link must parse");

  test("adds the desktop handoff flags for desktop-initiated joins", () => {
    const url = new URL(buildOrgInviteJoinUrl(link, { desktopAuth: true }));
    expect(url.origin).toBe("https://den.acme.example");
    expect(url.pathname).toBe("/join-org");
    expect(url.searchParams.get("invite")).toBe(NANOID_TOKEN);
    expect(url.searchParams.get("desktopAuth")).toBe("1");
    expect(url.searchParams.get("desktopScheme")).toBe("openwork");
  });

  test("supports a custom scheme and a plain browser join without desktop flags", () => {
    const dev = new URL(buildOrgInviteJoinUrl(link, { desktopAuth: true, desktopScheme: "openwork-dev" }));
    expect(dev.searchParams.get("desktopScheme")).toBe("openwork-dev");

    const web = new URL(buildOrgInviteJoinUrl(link, { desktopAuth: false }));
    expect(web.searchParams.get("invite")).toBe(NANOID_TOKEN);
    expect(web.searchParams.has("desktopAuth")).toBe(false);
    expect(web.searchParams.has("desktopScheme")).toBe(false);
  });
});

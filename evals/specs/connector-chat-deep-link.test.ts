import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { takePendingDeepLinks } from "../../apps/app/src/app/lib/deep-link-bridge";
import { parseChatDeepLink } from "../../apps/app/src/app/lib/openwork-links";
import {
  connectorPrompt,
  parseConnectorToken,
  seededConnectorDraft,
} from "../../apps/app/src/react-app/domains/session/surface/composer/connector-token";
import {
  connectorChatDeepLink,
  connectorChatPrompt,
  POPULAR_CONNECTORS,
} from "../../ee/apps/den-web/app/(den)/dashboard/_components/connector-catalog";

test("Den's connector Chat action seeds the desktop composer with the connector chip and its explain prompt", ({ evidence }) => {
  // Positive half: every popular connector's Chat link round-trips into a
  // composer draft that leads with the connector chip and ends with the prompt.
  for (const connector of POPULAR_CONNECTORS) {
    const href = connectorChatDeepLink({ connector: connector.displayName, prompt: connectorChatPrompt(connector.displayName) });
    const link = parseChatDeepLink(href);
    expect(link, href).not.toBeNull();
    expect(link?.connector).toBe(connector.displayName);
    expect(link?.prompt).toBe(connector.chatPrompt);
    expect(connector.chatPrompt.startsWith("Explain")).toBe(true);

    const draft = seededConnectorDraft({ connector: link?.connector ?? null, prompt: link?.prompt ?? "" });
    const [chip, ...rest] = draft.split("] ");
    expect(parseConnectorToken(`${chip}]`)).toBe(connector.displayName);
    expect(rest.join("] ")).toBe(connector.chatPrompt);
  }
  evidence.recordAssertionEvidence(
    "Popular connector Chat links seed a connector chip plus an Explain prompt",
    `Checked ${POPULAR_CONNECTORS.length} connectors: ${POPULAR_CONNECTORS.map((connector: { displayName: string }) => connector.displayName).join(", ")}.`,
    true,
  );

  // The chip expands into a steering sentence the model can act on.
  const github = parseChatDeepLink(connectorChatDeepLink({ connector: "GitHub", prompt: connectorChatPrompt("GitHub") }));
  expect(connectorPrompt(github?.connector ?? "")).toBe('Use the "GitHub" connector\'s tools for this request.');
  expect(github?.prompt).toBe(
    "Explain this repo's authentication using code and docs: components, request flow, and how credentials and tokens are handled",
  );
  evidence.recordAssertionEvidence(
    "The GitHub chip expands to a connector steering sentence ahead of the authentication explain prompt",
    `Chip text: ${connectorPrompt("GitHub")}`,
    true,
  );

  // Negative half: web URLs and sibling desktop routes never seed a chat, and
  // a chat link never disturbs the connect or den-auth links queued beside it.
  expect(parseChatDeepLink("https://app.openworklabs.com/chat?prompt=hello")).toBeNull();
  expect(parseChatDeepLink("openwork://connect?token=abc")).toBeNull();
  expect(parseChatDeepLink("openwork://den-auth?grant=abc")).toBeNull();
  expect(parseChatDeepLink("openwork://chat")).toBeNull();
  const queue = {
    deepLinks: ["openwork://connect?token=abc", "openwork://chat?connector=Notion&prompt=Explain", "openwork://den-auth?grant=xyz"],
  };
  const bridgeWindow = { __OPENWORK__: queue } as unknown as Window;
  expect(takePendingDeepLinks(bridgeWindow, (url: string) => parseChatDeepLink(url) !== null)).toEqual(["openwork://chat?connector=Notion&prompt=Explain"]);
  expect(queue.deepLinks).toEqual(["openwork://connect?token=abc", "openwork://den-auth?grant=xyz"]);
  evidence.recordAssertionEvidence(
    "Only openwork://chat links seed a chat, and taking them leaves connect and den-auth links queued",
    "Web, connect, den-auth, and empty chat URLs parsed to null; the shared queue kept its two non-chat links.",
    true,
  );
});

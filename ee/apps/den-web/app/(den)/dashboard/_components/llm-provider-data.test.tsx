import { parseDenLlmProvidersResponse } from "./llm-provider-data";

declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: any;

test("parses pending invited LLM provider member access entries", () => {
  const parsed = parseDenLlmProvidersResponse({
    llmProviders: [
      {
        id: "llmProvider_pending",
        organizationId: "org_pending",
        createdByOrgMembershipId: "om_creator",
        source: "models_dev",
        providerId: "openai",
        name: "OpenAI",
        providerConfig: {},
        credentialKind: "opencode_oauth",
        hasApiKey: false,
        hasOpencodeAuth: true,
        hasCredential: true,
        createdAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z",
        canManage: true,
        accessibleVia: { orgMembershipIds: [], teamIds: [] },
        models: [],
        access: {
          members: [
            {
              id: "llmProviderAccess_pending",
              orgMembershipId: "om_pending",
              role: "member",
              user: {
                id: null,
                name: "pending@example.com",
                email: "pending@example.com",
                image: null,
              },
              createdAt: "2026-06-10T00:00:00.000Z",
            },
          ],
          teams: [],
        },
      },
    ],
  });

  expect(parsed).toHaveLength(1);
  expect(parsed[0]?.access.members).toEqual([
    {
      id: "llmProviderAccess_pending",
      orgMembershipId: "om_pending",
      role: "member",
      user: {
        id: null,
        name: "pending@example.com",
        email: "pending@example.com",
        image: null,
      },
      createdAt: "2026-06-10T00:00:00.000Z",
    },
  ]);
});

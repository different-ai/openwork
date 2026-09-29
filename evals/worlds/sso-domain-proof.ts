import { queryDenDatabase, type Seed } from "@openwork/env";
import { ssoInvite } from "./den.ts";
import { invitationWitnesses, record, text } from "./org-invite.ts";

export async function legacySsoDomainOwnership(seed: Seed) {
  const world = await ssoInvite(seed);
  try {
    const database = world.den.database;
    if (!database) throw new Error("Domain ownership fixture requires an isolated database");
    const witnesses = invitationWitnesses(world.den.admin);
    const configuration = await witnesses.api("/v1/sso", { headers: { "x-openwork-org-id": world.organizationId } });
    if (!configuration.response.ok) throw new Error(`SSO fixture lookup: HTTP ${configuration.response.status}`);
    const connection = record(record(configuration.body).connection);
    if (connection.emailDomainVerified !== true) throw new Error("Controlled loopback IdP must start with genuine development proof");
    const providerId = text(connection.providerId);

    // Arrange a retained eligibility flag without current email-domain authority.
    // Moving the fixture issuer off loopback invalidates its development marker;
    // no ciphertext editing, real IdP, DNS record, or production credential is used.
    const legacyIssuer = "https://identity.example.test";
    await queryDenDatabase(database.url, "UPDATE sso_provider SET issuer = ? WHERE provider_id = ?", [legacyIssuer, providerId]);
    await queryDenDatabase(database.url, "UPDATE sso_connection SET issuer = ?, domain_verification_token = NULL WHERE provider_id = ?", [legacyIssuer, providerId]);
    await world.web.stop();

    return {
      ...world,
      web: world.adminWeb,
      async state() {
        const result = await witnesses.api("/v1/sso", { headers: { "x-openwork-org-id": world.organizationId } });
        if (!result.response.ok) throw new Error(`SSO state lookup: HTTP ${result.response.status}`);
        const payload = record(result.body);
        if (JSON.stringify(payload).includes("openworkEmailDomainProof")) throw new Error("SSO response exposed internal provenance");
        const current = record(payload.connection);
        const [challenge] = await queryDenDatabase(database.url, "SELECT domain_verification_token IS NOT NULL AND CHAR_LENGTH(domain_verification_token) > 0 AS has_token FROM sso_connection WHERE provider_id = ?", [providerId]);
        const challengeState = challenge ? record(challenge) : null;
        return {
          status: current.status,
          legacyVerified: current.domainVerified === true,
          emailDomainVerified: current.emailDomainVerified === true,
          hasToken: challengeState?.has_token === 1 || challengeState?.has_token === "1",
        };
      },
    };
  } catch (error) {
    await world[Symbol.asyncDispose]();
    throw error;
  }
}

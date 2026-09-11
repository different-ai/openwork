import { generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

// Ephemeral synthetic IdP material, never a real provider key or certificate.
export function signedScimSamlFixture() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cert = execFileSync("openssl", ["req", "-new", "-x509", "-key", "/dev/stdin", "-subj", "/CN=scim-saml.openwork.test", "-days", "1"], {
    input: privateKey, encoding: "utf8", timeout: 10_000,
  });
  const issuer = "http://127.0.0.1/scim-saml";
  return {
    issuer, cert,
    response(authorizationUrl: string, email: string, audience: string) {
      const url = new URL(authorizationUrl);
      const request = url.searchParams.get("SAMLRequest");
      if (!request) throw new Error("SAML sign-in did not issue an AuthnRequest");
      const xml = inflateRawSync(Buffer.from(request, "base64")).toString("utf8");
      const requestId = xml.match(/\bID="([^"]+)"/)?.[1];
      const acs = xml.match(/\bAssertionConsumerServiceURL="([^"]+)"/)?.[1];
      if (!requestId || !acs) throw new Error("AuthnRequest omitted ID or ACS");
      const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const now = new Date().toISOString();
      const expiry = new Date(Date.now() + 120_000).toISOString();
      const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${now}">
        <saml:Issuer>${issuer}</saml:Issuer>
        <saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${escape(email)}</saml:NameID>
          <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${escape(requestId)}" Recipient="${escape(acs)}" NotOnOrAfter="${expiry}"/></saml:SubjectConfirmation>
        </saml:Subject>
        <saml:Conditions NotBefore="${new Date(Date.now() - 30_000).toISOString()}" NotOnOrAfter="${expiry}"><saml:AudienceRestriction><saml:Audience>${escape(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>
        <saml:AuthnStatement AuthnInstant="${now}" SessionIndex="_${randomUUID()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>
        <saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${escape(email)}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>Avery Morgan</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>
      </saml:Assertion>`;
      const signature = new SignedXml({ privateKey, publicCert: cert,
        canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
        signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256" });
      signature.addReference({ xpath: "//*[local-name()='Assertion']", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"], digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256" });
      signature.computeSignature(assertion, { location: { reference: "//*[local-name()='Issuer']", action: "after" } });
      const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_${randomUUID()}" Version="2.0" IssueInstant="${now}" Destination="${escape(acs)}" InResponseTo="${escape(requestId)}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signature.getSignedXml()}</samlp:Response>`;
      return { acs, body: new URLSearchParams({ SAMLResponse: Buffer.from(response).toString("base64"), RelayState: url.searchParams.get("RelayState") ?? "" }).toString() };
    },
  };
}

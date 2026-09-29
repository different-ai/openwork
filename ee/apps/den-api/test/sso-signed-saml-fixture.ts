import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { SignedXml } from "xml-crypto"

export type SamlAttribute = { name: string; values: (string | null)[] }
export type SamlResponseOptions = {
  email: string
  attributes?: SamlAttribute[]
  signature?: "assertion" | "response" | "none"
  wrongCertificate?: boolean
  tamperSignature?: boolean
  issuer?: string
  audience?: string
  recipient?: string
  expired?: boolean
  inResponseTo?: string
  assertionId?: string
}

function signingMaterial() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  })
  // Node uses a socket for piped stdin on Linux; OpenSSL cannot reopen that
  // through /dev/stdin. A disposable file works on both Linux and macOS.
  const directory = mkdtempSync(join(tmpdir(), "openwork-saml-fixture-"))
  try {
    const keyPath = join(directory, "key.pem")
    writeFileSync(keyPath, privateKey, { mode: 0o600 })
    const cert = execFileSync("openssl", ["req", "-new", "-x509", "-key", keyPath, "-subj", "/CN=synthetic-saml.example.test", "-days", "1"], {
      encoding: "utf8", timeout: 10_000,
    })
    return { privateKey, cert }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const material = signingMaterial()
const wrongMaterial = signingMaterial()
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

function signed(xml: string, element: "Assertion" | "Response", keys: ReturnType<typeof signingMaterial>) {
  const signature = new SignedXml({
    privateKey: keys.privateKey,
    publicCert: keys.cert,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  })
  signature.addReference({
    xpath: `/*[local-name()='${element}']`,
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  })
  signature.computeSignature(xml, { location: { reference: `/*[local-name()='${element}']/*[local-name()='Issuer']`, action: "after" } })
  return signature.getSignedXml()
}

// No server or live IdP: issue a response to the SDK's actual AuthnRequest,
// signed using an ephemeral local certificate. Verification is entirely SDK-owned.
export function signedSamlFixture(issuer = "http://127.0.0.1/synthetic-saml") {
  const spIssuer = "http://localhost:3000/api/auth/sso/saml2/sp/metadata/synthetic-saml"
  return {
    issuer,
    cert: material.cert,
    config: {
      issuer: spIssuer,
      idpMetadata: { entityID: issuer },
      entryPoint: `${issuer}/sso`,
      cert: material.cert,
      audience: "http://localhost:3000",
    },
    response(authorizationUrl: string, options: SamlResponseOptions) {
      const url = new URL(authorizationUrl)
      const request = url.searchParams.get("SAMLRequest")
      assert.ok(request, "SAML sign-in must generate a real AuthnRequest")
      const xml = inflateRawSync(new Uint8Array(Buffer.from(request, "base64"))).toString("utf8")
      const requestId = xml.match(/\bID="([^"]+)"/)?.[1]
      const acs = xml.match(/\bAssertionConsumerServiceURL="([^"]+)"/)?.[1]
      assert.ok(requestId)
      assert.ok(acs)
      const responseTo = options.inResponseTo ?? requestId
      const responseIssuer = options.issuer ?? issuer
      const now = new Date().toISOString()
      const expiry = new Date(Date.now() + (options.expired ? -600_000 : 120_000)).toISOString()
      const notBefore = new Date(Date.now() - (options.expired ? 1_200_000 : 30_000)).toISOString()
      const assertionId = options.assertionId ?? `_${randomUUID()}`
      const attributes: SamlAttribute[] = [
        { name: "email", values: [options.email] },
        { name: "displayName", values: ["Synthetic Member"] },
        ...options.attributes ?? [],
      ]
      const attributeXml = attributes.map((attribute) => `<saml:Attribute Name="${escapeXml(attribute.name)}">${attribute.values.map((value) => value === null
        ? '<saml:AttributeValue xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true"/>'
        : `<saml:AttributeValue>${escapeXml(value)}</saml:AttributeValue>`).join("")}</saml:Attribute>`).join("")
      const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${escapeXml(assertionId)}" Version="2.0" IssueInstant="${now}">
        <saml:Issuer>${escapeXml(responseIssuer)}</saml:Issuer>
        <saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${escapeXml(options.email)}</saml:NameID>
          <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${escapeXml(responseTo)}" Recipient="${escapeXml(options.recipient ?? acs)}" NotOnOrAfter="${expiry}"/></saml:SubjectConfirmation>
        </saml:Subject>
        <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${expiry}"><saml:AudienceRestriction><saml:Audience>${escapeXml(options.audience ?? "http://localhost:3000")}</saml:Audience></saml:AudienceRestriction></saml:Conditions>
        <saml:AuthnStatement AuthnInstant="${now}" SessionIndex="_${randomUUID()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>
        <saml:AttributeStatement>${attributeXml}</saml:AttributeStatement>
      </saml:Assertion>`
      const signature = options.signature ?? "assertion"
      const keys = options.wrongCertificate ? wrongMaterial : material
      let response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_${randomUUID()}" Version="2.0" IssueInstant="${now}" Destination="${escapeXml(acs)}" InResponseTo="${escapeXml(responseTo)}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${escapeXml(responseIssuer)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signature === "assertion" ? signed(assertion, "Assertion", keys) : assertion}</samlp:Response>`
      if (signature === "response") response = signed(response, "Response", keys)
      if (options.tamperSignature) response = response.replace("Synthetic Member", "Tampered Member")
      return {
        assertionId,
        acs,
        body: new URLSearchParams({ SAMLResponse: Buffer.from(response).toString("base64"), RelayState: url.searchParams.get("RelayState") ?? "" }).toString(),
      }
    },
  }
}

import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { SignedXml } from "xml-crypto"

/** A disposable signing IdP, not a forged Den session or an unsigned assertion. */
export function samlIdentityProvider() {
  const directory = mkdtempSync(join(tmpdir(), "den-saml-idp-"))
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=synthetic-idp.example"], { stdio: "ignore" })
    const privateKey = readFileSync(join(directory, "key.pem"), "utf8")
    const cert = readFileSync(join(directory, "cert.pem"), "utf8")
    return {
      cert,
      respond(input: { authorizationUrl: string; issuer: string; audience: string; email: string; acs: string; tamper?: boolean }) {
        const url = new URL(input.authorizationUrl)
        const request = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest") ?? "", "base64")).toString()
        const requestId = request.match(/\bID="([^"]+)"/)?.[1]
        if (!requestId) throw new Error("Missing AuthnRequest ID")
        const now = new Date().toISOString()
        const expires = new Date(Date.now() + 300_000).toISOString()
        const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${now}" Destination="${input.acs}" InResponseTo="${requestId}"><saml:Issuer>${input.issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="_${randomUUID()}" Version="2.0" IssueInstant="${now}"><saml:Issuer>${input.issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${input.email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${input.acs}" NotOnOrAfter="${expires}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${now}" NotOnOrAfter="${expires}"><saml:AudienceRestriction><saml:Audience>${input.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now}" SessionIndex="_${randomUUID()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion></samlp:Response>`
        const signer = new SignedXml({ privateKey, publicCert: cert, signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#" })
        signer.addReference({ xpath: "//*[local-name()='Assertion']", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"], digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256" })
        signer.computeSignature(xml, { location: { reference: "//*[local-name()='Assertion']/*[local-name()='Issuer']", action: "after" } })
        const signed = input.tamper ? signer.getSignedXml().replace(input.email, "attacker@example.test") : signer.getSignedXml()
        return { SAMLResponse: Buffer.from(signed).toString("base64"), RelayState: url.searchParams.get("RelayState") ?? "" }
      },
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

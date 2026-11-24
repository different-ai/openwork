import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { SignedXml } from "xml-crypto"
import { createServer } from "node:http"

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

function html(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char)
}

/** Local interactive SAML peer: browser AuthnRequest -> signed POST binding. */
export async function startBrowserSamlIdp() {
  const signer = samlIdentityProvider()
  let config: { audience: string; acs: string; email: string } | undefined
  let origin = ""
  const events: { email: string; tampered: boolean }[] = []
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin)
      if (request.method === "GET") {
        if (!config) throw new Error("SAML peer not configured")
        const fields = [...url.searchParams].map(([name, value]) => `<input type="hidden" name="${html(name)}" value="${html(value)}">`).join("")
        response.writeHead(200, { "content-type": "text/html" })
        response.end(`<!doctype html><html><head><title>Synthetic SAML sign-in</title></head><body style="font:16px system-ui;max-width:480px;margin:70px auto"><h1>Synthetic organization sign-in</h1><p>Local test identity provider</p><form method="post">${fields}<label>Email <input name="email" type="email" value="${html(config.email)}"></label><p><button name="decision" value="approve">Approve sign-in</button> <button name="decision" value="tamper">Send invalid response</button></p></form></body></html>`)
        return
      }
      if (!config) throw new Error("SAML peer not configured")
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const form = new URLSearchParams(Buffer.concat(chunks).toString())
      const email = form.get("email") ?? config.email
      const tampered = form.get("decision") === "tamper"
      const signed = signer.respond({ authorizationUrl: `${origin}/sso?${form.toString()}`, issuer: origin, audience: config.audience, acs: config.acs, email, tamper: tampered })
      events.push({ email, tampered })
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
      response.end(`<!doctype html><html><body><form method="post" action="${html(config.acs)}"><input type="hidden" name="SAMLResponse" value="${html(signed.SAMLResponse)}"><input type="hidden" name="RelayState" value="${html(signed.RelayState)}"><button>Return to OpenWork</button></form><script>document.forms[0].submit()</script></body></html>`)
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" })
      response.end(String(error))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The local IdP did not bind a TCP port")
  origin = `http://127.0.0.1:${address.port}`
  return { origin, cert: signer.cert, events, configure(value: NonNullable<typeof config>) { config = value },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

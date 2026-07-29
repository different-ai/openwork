# egress-tls12-only — TLS 1.3 egress stalls are named instead of swallowed

1. The lab recreates the expensive field failure: TCP is open, Node can prove TLS 1.2 works, but a TLS 1.3 ClientHello stalls. OpenWork's shipped transport diagnostics name the TLS-handshake fault, and the frame captures today's Bun gap: Node-style TLS 1.2 pinning still advertises TLS 1.3 there.

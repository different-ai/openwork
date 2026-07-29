# egress-selective-deny — Host allowlist blocks are actionable

1. The lab blocks github.com like a corporate allowlist and also makes the product Cloud MCP probe see an HTTP 451. The lab response names github.com and the allowlist manifest, while OpenWork's shipped diagnostics classify the 451 as an egress allowlist deny.

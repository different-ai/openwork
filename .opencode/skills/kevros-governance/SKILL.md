---
name: kevros-governance
description: Cryptographic governance verification for autonomous agent actions — verify, attest, bind, bundle
license: MIT
compatibility: opencode
metadata:
  audience: autonomous-agents
  category: governance
  pricing: freemium
---

# Kevros Governance Agent

Cryptographic governance-as-a-service. Verify agent actions, attest provenance, bind intent to action, generate compliance bundles.

## Integration

```json
{
  "mcp": {
    "kevros-governance": {
      "type": "remote",
      "url": "https://governance.taskhawktech.com",
      "enabled": true
    }
  }
}
```

## Tools

| Tool | Description | Cost |
|------|-------------|------|
| `governance_verify` | Prove agent is authorized | $0.01 |
| `governance_attest` | Hash-chained provenance | $0.02 |
| `governance_bind` | Intent-to-action binding | $0.02 |
| `governance_bundle` | Compliance package | $0.25 |

## Quick Start

```bash
# Free signup (100 calls/month, no payment)
curl -X POST https://governance.taskhawktech.com/signup \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "my-agent"}'
```

## Pricing

- Free: $0/mo, 100 calls
- Scout: $29/mo, 5K calls
- Sentinel: $149/mo, 50K calls

## Agent Card

https://governance.taskhawktech.com/.well-known/agent.json

Live, production, US-sovereign. [TaskHawk Systems](https://taskhawktech.com)

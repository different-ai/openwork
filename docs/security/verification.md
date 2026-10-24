# Verification record

Date: 2026-10-21. Reviewed product baseline: `866db910ef214ce8c5d2377a662473990062acf5`.

## Performed

- Static source review of desktop/runtime, Den/inference, MCP/headless/Cloud and network/TLS paths, including the related browser/scheduler checkouts and non-admin-install PR evidence cited in the document.
- Independent source review of high-risk assertions and diagram consistency. Corrected the diagrams to distinguish headless versus full Cloud, direct versus managed inference, first-party versus external telemetry, and suspended legacy versus v2 agent-permission enforcement.
- Rendered all three Mermaid sources to PNG and SVG using pinned Mermaid CLI `11.12.0`, headless installed Chrome, the checked-in configuration and `bash docs/security/diagrams/render.sh`.
- Opened the rendered PNGs and iterated on layout. The core managed-route and desktop-access figures use readable portrait layouts; the detailed alternatives figure is a landscape reference, also supplied as zoomable SVG.
- Validated local Markdown links, source line anchors and all 42 footnote definitions: no missing files, out-of-range linked line anchors or undefined footnotes.
- Parsed all three SVG documents (no script elements) and checked all three PNG signatures/dimensions.
- `bash -n docs/security/diagrams/render.sh`: passed.
- `git diff --cached --check`: passed before commit.
- Scanned the authored text for customer identification, local absolute/home paths and credential-like GitHub tokens: none found.

## Not performed / not claimed

No application source, API contract, configuration or dependency was changed. Application builds and product E2E were not run for this documentation-only change. The artifacts were actually rendered; they are not product screenshots or a simulated successful deployment.

This review did not launch the product, inspect production credentials/configuration, run a packet capture or penetration test, validate released binary signatures, re-run the referenced installation experiment, or certify customer endpoint/EDR/TLS-inspection compatibility. Deployment settings, upstream contracts, infrastructure encryption/residency, audit coverage gaps and deletion lifetimes remain explicitly qualified in the document.

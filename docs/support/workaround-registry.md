# Workaround registry

Field workarounds must be recorded when they are applied. Otherwise they become unexplained state on customer machines and cost support time later. In the incomplete TLS-chain incident, an unexplained 178-cert `NODE_EXTRA_CA_CERTS` file cost hours because no one could tell why it existed, who added it, or when it could be removed.

Use this table for every temporary customer-machine change:

| id | date | customer/machine | exact change | applied by | removal condition | rot risk |
| --- | --- | --- | --- | --- | --- | --- |
| `tls-chain-digicert-g2-bridge-001` | 2026-07-27 | Affected self-hosted Den customer machines | Append the `DigiCert Global G2 TLS RSA SHA256 2020 CA1` intermediate to the affected machines' `NODE_EXTRA_CA_CERTS` file as a bridge until the customer serves the fullchain. | OpenWork support with customer approval | Remove after `openssl s_client -showcerts` against the Den origin counts at least 2 certificates. | Certificate renewal may rotate the intermediate; the current leaf expires Jan 2027. |

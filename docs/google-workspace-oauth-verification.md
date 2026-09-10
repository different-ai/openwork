# Google Workspace OAuth Verification

Google Workspace uses only OpenWork Cloud connections. The former desktop OAuth
verification procedure no longer applies: there is no local Google Workspace
extension, loopback sign-in flow, or desktop OAuth environment setup.

For account setup, follow [Connect your services](../packages/docs/start-here/connect-your-stack/connect-services.mdx#google-workspace):
sign in to OpenWork Cloud, open `Settings` > `Library` > `Connections`, select
the Google connection, and click `Connect`. Organization administrators configure
Google connections in Cloud `Connectors`, not in a desktop extension.

Verification must cover the Cloud connection's actual consent screen and the
permissions configured for that connection. The retired desktop client's scope
list and recording procedure are not evidence for Cloud OAuth verification.

Removing local setup does not delete stored local credentials or user files,
migrate tokens, revoke Google access, or disconnect existing Cloud connections.

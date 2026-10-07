# OpenWork

Shared language for OpenWork and its integrations.

## Language

### Connect

**Hosted OpenWork Connect**:
OpenWork Connect operated by OpenWork, rather than an organization-operated deployment.
_Avoid_: Self-hosted Connect (when referring to the OpenWork-operated service)

### Slack

**OpenWork-supplied Slack app**:
The Slack application that OpenWork provides and configures for members to authorize for use in OpenWork Connect.
_Avoid_: Client, connector, Marketplace listing (when referring to the Slack application itself)

**No-developer-setup connection**:
A connection that does not require the member or their organization to create a Slack app, configure its permissions, or supply app credentials. Slack workspace administrator approval and individual member authorization may still be required.
_Avoid_: Zero setup, approval-free connection

**Connected Slack account**:
A member's authorized Slack identity within one Slack workspace.
_Avoid_: Slack app, shared organization account

**Slack app installation**:
The workspace's authorization of the OpenWork-supplied app, distinct from each member's permission to search their own conversations. Its bot grant supports the connection/help surface, not member lookups.
_Avoid_: Connected Slack account, shared search token

**Slack conversation**:
A public channel, private channel, one-to-one direct message, or group direct message in Slack.
_Avoid_: Channel (when direct messages are also included)

**Slack thread**:
A parent Slack message and its replies.

**Slack thread excerpt**:
A partial view of a Slack thread that does not represent all of its replies.
_Avoid_: Complete thread, full conversation

**Live Slack lookup**:
A read of Slack information for a specific user or authorized workflow request, rather than an ongoing import of Slack history.
_Avoid_: Slack sync, Slack archive

**Internal Slack validation**:
Use of the Slack connector within OpenWork's own organization and Slack workspace. An invite-only installation in an external organization's workspace is not internal validation.
_Avoid_: Private customer pilot, unlisted external pilot

**Slack validation workspace**:
An OpenWork-owned Slack workspace containing synthetic test conversations for the connector's live acceptance checks, rather than ordinary business conversations or outside organizations' data.
_Avoid_: Customer pilot workspace, production Slack workspace

**Limited Slack access**:
A usable connected Slack account whose granted permissions cover only some supported conversation categories.
_Avoid_: Broken connection, no results (when the actual limitation is missing permission)

**Slack connection/help surface**:
A minimal informational experience inside Slack that explains the OpenWork integration and provides access to connection management. It is not a conversational Slack bot.
_Avoid_: Slack chatbot, Slack assistant (when referring only to connection information and help)

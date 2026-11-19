# Request only chosen scopes (`connectionSelectedScopesOnly`)

- **Feature key:** `connectionSelectedScopesOnly`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

In **Manage › Connectors**, a connector that signs in with an account has a
new checkbox in **Settings**, under **Requested OAuth scopes**:

> **Request only these scopes**
> Leaves out any other scopes the server asks for at sign-in. People who
> already signed in keep their access until they sign in again.

The checkbox is greyed out until at least one scope is listed. It is off for
every existing connector.

Without the feature, the checkbox is not shown and sign-in always asks for
every scope the server's sign-in challenge names, plus the listed ones.

## Why

An MCP server tells OpenWork which scopes to ask for when it refuses an
unsigned request. Some servers name every scope they support there, including
ones for making changes, although reading needs only a few. Until now an
admin could add scopes to that list but never ask for fewer, so a team that
only wanted read access was still asked to approve everything.

## How it works

- The choice is saved on the connection as `requestSelectedScopesOnly`, next
  to `requestedScopes` (`POST` and `PUT /v1/mcp-connections`, returned on the
  connection). Turning it on with no scopes listed is refused. An update that
  leaves it out keeps the saved choice.
- When a person starts a sign-in, OpenWork replaces the scope list on the
  sign-in address with the listed scopes. `offline_access` is kept when it
  was going to be requested, so access can still renew.
- Changing the choice does not sign anyone out. People who signed in earlier
  keep what they were granted until they sign in again.
- A tool that needs a scope the admin left out fails at the server until the
  admin adds that scope.

## Turning it off

With the feature off for an organization, or with the kill switch on:

- the checkbox is hidden and the API refuses to turn the choice on
  (`404 feature_disabled`);
- a saved choice stays saved but is ignored: the next sign-in asks for every
  scope the server names again;
- sign-ins already made keep working.

Turning the feature back on makes saved choices apply again.

## How to try it

1. Turn `connectionSelectedScopesOnly` on for an organization in `/admin`.
2. Add a connector whose server names more scopes than you need, open its
   **Settings**, list the scopes you want, tick **Request only these scopes**
   and save.
3. Click **Sign in**: the provider's consent screen lists only those scopes.

Covered by `ee/apps/den-api/test/api/mcp-oauth.api.test.ts`.

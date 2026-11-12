# Sign-in: account email follows Google or SSO

- Feature: `signInEmailSync`
- Deployments: cloud and self-hosted; default **off**.
- Author: `benjaminshafii`
- Not owned by an organization: a sign-in happens before any organization is
  chosen, so den-api reads the deployment-wide state
  (`deploymentFeatureEnabled`). Organization and member overrides do nothing.
- Not visual: nothing new is drawn. The email shown on the person's profile
  and in Members changes after they sign in.

## The problem

Den finds a returning Google or SSO sign-in by the provider's own id (Google's
`sub`, an OIDC `sub`, a SAML NameID). When no account has that id, it falls
back to the email, and when no account has that email it creates one.

So when someone's email changes at the provider (a rename in the company
directory, `pat.long@acme.test` to `pat@acme.test`):

1. Google still opens their existing account, because Google's id did not
   change. Den kept the old email on that account.
2. An SSO connection whose subject **is** the email (the default NameID for
   Google Workspace SAML, and common elsewhere) sees a new id and a new email.
   Nothing matches, and Den creates a second account for the same person.

The person now has two accounts in one organization: different role, other
conversations, and computers registered to one account are invisible to the
other. Which one they get depends on the button they pressed.

## What changes

On, a returning sign-in moves the account to the email its provider reports:

| Sign-in | The account follows when |
|---|---|
| Google | Google reports the email as verified |
| SSO (OIDC or SAML) | the email is on the SSO connection's verified domain |
| GitHub, password, email code | never: GitHub's primary email is a preference people switch between addresses |

After step 1 above the account has the new email, so step 2 finds it by email
and adds the SSO identity to it instead of creating a second account
(`followProviderEmail` in `ee/apps/den-api/src/account-linking-policy.ts`).

Rules it keeps:

- **Never takes an email another account has.** The sign-in still opens the
  person's own account, nothing changes, and den-api logs `sign-in email not
  followed: another account already has the provider's email` with both user
  ids. Joining two accounts moves memberships and data, so it stays a person's
  decision.
- **Never fails a sign-in.** Any error while following is logged and the
  sign-in continues with the stored email.
- **Verification follows the proof.** After Google the email is verified. After
  SSO a verified account stays verified (the connection owns the new address's
  domain) and an unverified one stays unverified.
- The session created by that same sign-in still carries the old email; the
  next request reads the new one.

## What it does not fix

- **SSO first.** If the person signs in with the email-keyed SSO connection
  before they sign in with Google, the second account is created exactly as
  before: Den has nothing that ties the new email to the old account at that
  moment. Their next Google sign-in then hits the "another account already has
  it" case above. A stable SSO subject (a persistent NameID) or SCIM avoids it;
  otherwise someone has to join the two accounts.
- **Accounts already split.** Nothing is merged.
- **Two linked providers that disagree.** If Google and SSO keep reporting
  different emails for one person, the account takes the email of whichever
  they signed in with last.

## How to try it

`ee/apps/den-api/test/account-linking-policy.test.ts` runs the whole sequence
against a real Better Auth instance, off and on:

```bash
pnpm --filter @openwork-ee/den-api exec node --conditions=development --import tsx --test test/account-linking-policy.test.ts
```

By hand: turn the feature on for everyone in `/admin` › Features, sign in with
Google, change that Google account's email, sign in with Google again, and the
profile shows the new email.

## Turning it off

The kill switch stops accounts from following from the next sign-in on. Emails
that already moved stay moved; they are correct, and nothing reads the old
address again.

## What to watch

- den-api logs for `sign-in email not followed`: each one with two user ids is
  a person who already has two accounts.
- The audit log records the email change as a profile update by that user.
- Anything matched by email outside Den follows the new address from then on,
  for example the LiteLLM user a member's gateway keys are issued from.

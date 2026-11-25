# Review OpenAI safety notices

- **Status:** always on; `freeAutoSafetyCases` was retired in November 2026.

This workflow covers Free Auto requests paid for by OpenWork through Chat Completions and Responses. Platform admins can review provider cases, identify a matching signed-in user, inspect recent request IDs, and stop future free model requests. Warnings open for review. A verified deactivation creates a durable block for the supplied Free Auto identifier. A block applies in every organization where that identity uses Free Auto.

## Set up the receiving endpoint

1. Upgrade Den and every gateway replica.
2. In the OpenAI organization that owns the inference credential, register the Den endpoint `/v1/webhooks/openai/safety` for `safety.warning_issued` and `safety.deactivation_issued`. Set `OPENAI_SAFETY_WEBHOOK_SECRET` in Den and configure `OPENAI_SAFETY_READ_KEY` with only the organization's Safety Read permission. Use the documented organization-level setup. [OpenAI safety enforcement notifications](https://developers.openai.com/api/docs/guides/safety-enforcement)
3. Verify delivery and import a known case. The receiver verifies the signature and timestamp over the raw event, looks up the case on the fixed OpenAI API host, and acknowledges supported notices after committing them. Monitor non-success webhook deliveries. A failed lookup returns 503 so OpenAI retries. After the delivery window, import missed cases by ID. Repeated delivery preserves prior decisions. [OpenAI webhooks](https://developers.openai.com/api/docs/guides/webhooks)
4. The gateway records the signed-in user mapping before dispatch and checks for any open block on the primary database. An in-flight request can finish. Older usage can be matched if its original membership still identifies the same user.

## Work a case

The following paths require a platform administrator's authenticated Den session. Keep the case ID, assignee, due time, incident timestamp, evidence references and disposition in an access-controlled incident record. Keep prompt contents, credentials, and personal details out of tickets by default.

| Situation | Operator action |
| --- | --- |
| An email or webhook names a case | For an email, send `POST /v1/admin/free-auto/safety-cases/import` with `{"caseId":"C-example"}`. Den verifies the case with OpenAI. Review waiting cases with `GET /v1/admin/free-auto/safety-cases?state=review` and provider or local blocks with `state=blocked`. Pass `nextCursor` as `cursor` for the next page. |
| A warning names an identifier | Open `GET /v1/admin/free-auto/safety-cases/C-example`. Check the member match, request IDs and times against the notice and authorized request logs. The provider's case creation time can differ from the activity time. Guest evidence can represent a shared machine or network. A count of other accounts on shared desktops is a lead for review. |
| An organization-level warning gives no identifier | Confirm the notice and affected OpenAI organization, project, credentials, endpoints and time window. Find specific request evidence, including failed upstream requests where available. For a matching ledger request send `POST /v1/admin/free-auto/safety-cases/from-request` with `{"requestId":"<OpenWork request ID>"}`. Follow the returned local case. If attribution is inconclusive, escalate for provider details and contain the affected credential or route under the incident procedure. |
| Review is in progress | Assign an owner. If containment is warranted, use the existing time-limited safety pause and set a review deadline before expiry. An isolated request refusal or an ordinary spend alert alone does not establish misconduct. |
| Review confirms misuse | Send `POST /v1/admin/free-auto/safety-cases/{caseId}/decision` with `{"decision":"confirmed_misuse"}`. Verify effective enforcement. Review later attempts and any other OpenWork-funded routes using the same provider account. An explicit provider account-suspension request also requires prompt action at the account scope specified in the notice. |
| Investigation clears a warning, or a local appeal succeeds | Record `no_violation` on an open warning or local review, or `appeal_upheld` on its local block. The case keeps each reviewer, decision and time. Other cases and temporary pauses keep their own state. Use the provider appeal path for a disputed deactivation. Ordinary local review cannot lift provider deactivations. |

A different OpenWork account has a different safety identifier. Review corroborated evidence before restricting additional identities. Never issue a replacement identifier or switch a restricted request to a different credential or model to get around a provider block. Use account or credential containment separately when needed, including for suspected compromise. This feature leaves organization creation and other provider routes under their existing controls.

## Policy references

The published Services Agreement assigns responsibility for end-user use to the customer and describes suspension requests in section 8.1. Check the agreement governing the deployment and the actual notice when deciding scope. [OpenAI Services Agreement](https://openai.com/policies/services-agreement/) · [Usage Policies](https://openai.com/policies/usage-policies/)

OpenAI recommends a stable, pseudonymous end-user identifier and controls against repeat access after a block. OpenWork assigns the identifier server-side. Keep an internal support path for disputed findings and use the appeal instructions in provider notices. [Safety best practices](https://developers.openai.com/api/docs/guides/safety-best-practices) · [Safety checks](https://developers.openai.com/api/docs/guides/safety-checks)

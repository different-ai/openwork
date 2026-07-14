1. OpenRouter sends usage data to the inference webhook for an organization’s request.

2. The server checks the reported model against the supported model catalog in the types package.

3. If the model is unknown and its cost cannot be calculated, no estimated deduction is made. Sentry receives a critical/fatal event with the reported model, organization ID, request ID, and usage metadata—excluding secrets and prompt content.

4. Known models continue through normal cost calculation and bucket deduction without a Sentry error.

# managed-models-empty-recovery — Managed models recover from empty desktop state

This demo proves organization-published models are imported before restriction enforcement, and that a genuinely empty managed-model state is honest and recoverable.

1. In OpenWork Cloud, the administrator has published OpenRouter with one model, GLM-5.2, and the dashboard says the reporting member sees exactly GLM-5.2.

2. The member opens the desktop app after sign-in. The model control settles on GLM-5.2 by itself, with no model-unavailable picker and no manual click.

3. We deliberately clear the local cloud import while the organization still restricts custom providers. The desktop does not auto-open an empty picker; the composer says the organization has not published any models yet and offers Refresh organization models.

4. The member clicks Refresh organization models. The organization model is imported again, GLM-5.2 becomes selectable, and the composer is ready to run a task.

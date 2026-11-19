# Install OpenWork in your Google Cloud project

## Review the installation

Use a dedicated, billing-enabled project. The installer creates Cloud SQL,
Cloud Run API/Web services, HTTPS load balancing, a certificate, Cloud DNS
records, Secret Manager secrets, a five-minute read-only health job, and
retained, versioned GCS Terraform state. These resources incur Google Cloud
charges. Installer permissions span the dedicated project. Do not use a project
containing unrelated production workloads.

Your project, domain and administrator address remain configuration inside your
project. Hosted OpenWork receives authenticated progress and allowlisted health
checks; it does not receive database contents, secret values, logs or state.
No service-account keys are created. Deleting or closing the installer does
not remove state or the database. Updates and retries require fresh approval.

## Approve in Cloud Shell

Open Cloud Shell from the OpenWork approval link. Select the project and run
the command copied from OpenWork. It verifies the immutable release bundle's
SHA-256 before executing code. Review the exact project number, region,
domain and release, then type the project ID at the approval prompt. The
installer also asks you to authorize local application-default credentials;
Terraform impersonates only the dedicated installer service account.

Before approval, have your administrator check the **signed-in Cloud Shell
operator's** bootstrap rights: enable the required APIs, create/list the five
deployment service accounts, set project IAM bindings, create/read the custom
drain role, and create/configure the private versioned state bucket and its IAM.
The operator must also have **`iam.serviceAccounts.getIamPolicy` and
`iam.serviceAccounts.setIamPolicy` on the deployment's service accounts**.
Project IAM Admin plus Role Administrator alone does **not** provide that
service-account-policy permission. Service Account Admin
(`roles/iam.serviceAccountAdmin`) is an administrative example; prefer scoped
equivalent permissions where possible. These rights belong to the approving
operator, **never the installer runner**. Any temporary operator grant requires
explicit administrator approval and must be removed after the approved work.

If project IAM, service-account IAM, API enablement, public invocation or DNS is
blocked by your organization's policy, ask your Google Cloud administrator to
approve this installation. The installer does not weaken those policies
automatically or repair operator access by broadening the runner's permissions.
If your domain or a parent domain has CAA records, allow `pki.goog` (Google Trust
Services) in the closest non-empty CAA record set, or the managed HTTPS
certificate will not be issued.
Certificate issuance may take up to an hour after DNS records are created.
Keep Cloud Shell open until all six installation milestones finish. A failed
or closed run can be retried with a fresh command; it reuses retained state.

## Set up your organization

After OpenWork reports Ready, open the displayed setup URL. Retrieve the
`ow-<deployment prefix>-bootstrap` value from **your project's Secret Manager**
and use it to create your first administrator. Never paste the code into the
hosted control plane or support messages. Rotate/remove the bootstrap code
after setup. Configure your organization's SMTP/SSO after signing in.

## Updates

Approve each version from OpenWork, then run its new Cloud Shell command.
The runner applies a saved, inspected Terraform plan, runs database migrations
before releasing new service revisions, and refuses plans that delete or
replace data-bearing resources. Back up and test restores before an upgrade.
Updates and retries remove Cloud Run revision tags on the OpenWork services;
recreate any you need afterwards on the new API-only revisions.
Reverting a service revision does not revert database schema migrations.

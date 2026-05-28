# Cloud provider sync flows

End-to-end user flows for organization-managed LLM providers syncing from Den to
the desktop app and workspace config.

## Preflight

1. Start a Daytona Den server sandbox and a Daytona Electron sandbox pointed at it.
2. Sign the desktop app into Cloud Account.
3. Create or select a local workspace through the desktop UI.
4. Ensure the workspace has a writable `opencode.jsonc`.

## Flow 1: Provider add-to-use

**Goal:** A provider created in Den appears in the desktop app, imports into the
workspace, and becomes selectable as a model provider.

### Setup

Create an org LLM provider through Den API:

```bash
curl -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data '{
    "name":"Eval Provider",
    "source":"custom",
    "customConfigText":"{\"id\":\"eval_provider\",\"name\":\"Eval Provider\",\"npm\":\"@ai-sdk/openai-compatible\",\"env\":[\"EVAL_API_KEY\"],\"doc\":\"https://example.com\",\"api\":\"https://api.example.com/v1\",\"models\":[{\"id\":\"eval-model\",\"name\":\"Eval Model\"}]}",
    "apiKey":"sk-eval"
  }' \
  "$DEN_API_URL/v1/llm-providers"
```

### Steps

1. Open Settings -> Cloud -> Cloud Providers.
2. Click `Refresh`.
3. Verify the provider appears under `Available`.
4. Click `Import`.
5. Click the reload banner if shown.
6. Open the model selector in the session composer.

### Expected outcome

- The provider appears with `Credential ready`.
- `opencode.jsonc` contains an `lpr_*` provider block.
- The model selector shows the imported provider/model.
- No provider key is written to the visible provider config.

## Flow 2: Provider update sync

**Goal:** A provider changed in Den is detected by desktop and can be refreshed.

### Steps

1. Import a provider using Flow 1.
2. Update the provider in Den by changing the name and model list.
3. Open Settings -> Cloud -> Cloud Providers.
4. Click `Refresh`.
5. Verify the provider row marks itself out of sync or updates its metadata.
6. Import or re-import the provider.
7. Inspect `opencode.jsonc`.

### Expected outcome

- The changed provider metadata is visible in the desktop UI.
- `opencode.jsonc` reflects the new model list after sync.
- Removed models are not left as stale selectable models.

## Flow 3: Provider delete sync

**Goal:** A provider deleted from Den is removed from the desktop cloud-imported
state.

### Steps

1. Import a provider using Flow 1.
2. Delete the provider in Den API.
3. Open Settings -> Cloud -> Cloud Providers.
4. Click `Refresh` or wait for cloud sync.
5. Inspect `opencode.jsonc`.

### Expected outcome

- The provider disappears from Cloud Providers.
- The local `lpr_*` provider block is removed or disabled.
- The model selector no longer shows the deleted cloud provider.
- Local non-cloud providers remain untouched.

## Flow 4: Refresh timing

**Goal:** Measure how quickly server-side provider changes are visible in the
desktop UI.

### Steps

1. Open Cloud Providers.
2. Create a provider through Den API and record `createdAt` or local timestamp.
3. Immediately click `Refresh` in the desktop UI.
4. Poll `document.body.innerText` over CDP until the provider name appears.

### Expected outcome

- Manual refresh should reveal the provider within a few seconds.
- Record the measured duration in the eval report.
- Automatic interval sync is expected to be slower; current interval is 5 minutes.

## Flow 5: Reload required banner

**Goal:** Importing a provider tells the user to reload the workspace and reload
applies the config.

### Steps

1. Import a cloud provider into an active workspace.
2. Verify the UI shows `Reload required` or equivalent messaging.
3. Click `Reload now`.
4. Open the model selector.

### Expected outcome

- Reload banner appears after config changes.
- Reload completes without losing the selected workspace.
- Imported cloud model is selectable after reload.

## Flow 6: Permission boundary

**Goal:** A member without provider-management permissions cannot create or edit
org providers, but can consume providers granted to them.

### Setup

Invite a member account to the org. Grant that member access to one provider.

### Steps

1. Sign in as the member.
2. Open Cloud Providers.
3. Verify the granted provider is visible and importable.
4. Attempt to create or edit a provider through Den Web or API.

### Expected outcome

- Granted provider is consumable by the member.
- Provider create/edit returns forbidden or hides the control for non-admin users.

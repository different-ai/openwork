import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { openAdminConnections, signInViaBrowser } from "./lib/den-web.mjs";

const FLOW_ID = "github-public-mcp-preview";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const FIXTURE_SHA = "47caa757e4730eb8daf7d335470f692d4a68b59e";
const FIXTURE_REVISION_LABEL = FIXTURE_SHA.slice(0, 12);
const FIXTURE_ROOT_PATH = "partner-built/slack";
const FIXTURE_REPOSITORY = "anthropics/knowledge-work-plugins";
const FIXTURE_URL = `https://github.com/${FIXTURE_REPOSITORY}/tree/${FIXTURE_SHA}/${FIXTURE_ROOT_PATH}`;
const EXPECTED_SCOPE = "search:read.public";
const IMPORT_PATH = "/v1/plugins/import-mcps-from-github-url";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function previewItem(capture) {
  const item = capture?.preview?.responseBody?.item;
  if (!isRecord(item)) throw new Error(`Preview capture did not contain an item: ${JSON.stringify(capture).slice(0, 800)}`);
  return item;
}

function slackServer(item) {
  const servers = Array.isArray(item.servers) ? item.servers : [];
  const server = servers.find((entry) => isRecord(entry)
    && (String(entry.name ?? "").toLowerCase() === "slack" || entry.url === "https://mcp.slack.com/mcp"));
  if (!isRecord(server)) throw new Error(`Pinned fixture preview did not contain Slack: ${JSON.stringify(servers).slice(0, 800)}`);
  return server;
}

async function installImportCapture(ctx) {
  await ctx.eval(`(() => {
    if (window.__openworkEvalGithubImportOriginalFetch) {
      window.fetch = window.__openworkEvalGithubImportOriginalFetch;
    }
    const originalFetch = window.fetch.bind(window);
    window.__openworkEvalGithubImportOriginalFetch = originalFetch;
    window.__openworkEvalGithubImportCapture = { calls: [], preview: null };
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const shouldCapture = url.includes(${JSON.stringify(IMPORT_PATH)});
      const requestHeaders = {};
      if (shouldCapture) {
        try {
          for (const [name, value] of new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries()) {
            requestHeaders[name.toLowerCase()] = value;
          }
        } catch {}
      }
      const response = await originalFetch(input, init);
      if (shouldCapture) {
        const rawBody = typeof init?.body === 'string' ? init.body : null;
        let responseBody = null;
        try {
          const text = await response.clone().text();
          responseBody = text ? JSON.parse(text) : null;
        } catch {}
        const call = {
          method,
          requestBody: rawBody,
          requestHeaders,
          responseBody,
          responseStatus: response.status,
          url,
        };
        window.__openworkEvalGithubImportCapture.calls.push(call);
        if (url.includes(${JSON.stringify(`${IMPORT_PATH}/preview`)})) {
          window.__openworkEvalGithubImportCapture.preview = call;
        }
      }
      return response;
    };
    return true;
  })()`);
}

async function capturedImportTraffic(ctx) {
  return ctx.eval("window.__openworkEvalGithubImportCapture ?? null");
}

async function openPluginBundleDialog(ctx) {
  await openAdminConnections(ctx);
  await ctx.waitForText("Add a connection", { timeoutMs: 30_000 });
  await ctx.clickText("Plugin bundle");
  await ctx.waitForText("Add plugin connection", { timeoutMs: 10_000 });
}

async function selectSlackForReview(ctx) {
  const selected = await ctx.eval(`(() => {
    const row = [...document.querySelectorAll('tr')].find((candidate) =>
      [...candidate.querySelectorAll('td')].some((cell) => (cell.textContent ?? '').trim().toLowerCase() === 'slack')
    );
    const checkbox = row?.querySelector('input[type="checkbox"]');
    if (!checkbox) return { found: false, checked: false };
    if (!checkbox.checked) checkbox.click();
    return { found: true, checked: checkbox.checked };
  })()`);
  ctx.assert(selected?.found && selected.checked, `Slack could not be selected for review: ${JSON.stringify(selected)}`);
  await ctx.waitFor(
    `(() => [...document.querySelectorAll('p')].some((entry) => (entry.textContent ?? '').trim().toLowerCase() === 'configure slack'))()`,
    { timeoutMs: 10_000, label: "Slack configuration card" },
  );
}

async function scrollConfigurationIntoView(ctx) {
  const scrolled = await ctx.eval(`(() => {
    const heading = [...document.querySelectorAll('p')].find((entry) => (entry.textContent ?? '').trim().toLowerCase() === 'configure slack');
    const card = heading?.closest('div.rounded-2xl');
    card?.scrollIntoView({ block: 'start' });
    return Boolean(card);
  })()`);
  ctx.assert(scrolled, "Slack configuration card was not available to review.");
}

async function scrollAssignmentIntoView(ctx) {
  const scrolled = await ctx.eval(`(() => {
    const heading = [...document.querySelectorAll('span')].find((entry) => (entry.textContent ?? '').trim() === 'Who can use this import?');
    const card = heading?.closest('div.rounded-2xl');
    card?.scrollIntoView({ block: 'center' });
    return Boolean(card);
  })()`);
  ctx.assert(scrolled, "Import assignment controls were not available to review.");
}

export default {
  id: FLOW_ID,
  title: "Admins safely review auto-discovered MCP setup from a pinned public GitHub bundle",
  kind: "user-facing",
  spec: "evals/voiceovers/github-public-mcp-preview.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame 1 — Enter a pinned public bundle",
      run: async (ctx) => {
        await ctx.prove("A public GitHub bundle can be submitted for review without a GitHub token or secret", {
          voiceover: vo[0],
          action: async () => {
            await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await openPluginBundleDialog(ctx);
            await installImportCapture(ctx);
            await ctx.fill('input[placeholder^="https://github.com/"]', FIXTURE_URL);
          },
          assert: async () => {
            const form = await ctx.eval(`(() => {
              const heading = [...document.querySelectorAll('h2')].find((entry) => (entry.textContent ?? '').trim() === 'Add plugin connection');
              const dialog = heading?.parentElement;
              const input = dialog?.querySelector('input[placeholder^="https://github.com/"]');
              return {
                githubUrl: input?.value ?? null,
                passwordFieldCount: dialog?.querySelectorAll('input[type="password"]').length ?? -1,
              };
            })()`);
            ctx.assert(form.githubUrl === FIXTURE_URL, `Pinned public URL was not entered exactly: ${JSON.stringify(form)}`);
            ctx.assert(form.passwordFieldCount === 0, "The unpreviewed public GitHub form exposed a credential field.");
            const capture = await capturedImportTraffic(ctx);
            ctx.assert(Array.isArray(capture?.calls) && capture.calls.length === 0, "Opening the review form made an import request before Preview.");
          },
          screenshot: {
            name: "public-pinned-github-url",
            claim: "The plugin review starts with one public GitHub URL and no credential prompt.",
            requireText: ["Add plugin connection", "GitHub plugin URL", "Preview", "Import from GitHub"],
            rejectText: ["GitHub token", "Client secret", "Plugin imported"],
          },
        });
      },
    },
    {
      name: "Frame 2 — Review the immutable preview",
      run: async (ctx) => {
        await ctx.prove("The preview is pinned to the requested commit and keeps bundled skills opt-in", {
          voiceover: vo[1],
          action: async () => {
            await ctx.clickText("Preview");
            await ctx.waitForText(FIXTURE_REVISION_LABEL, { timeoutMs: 30_000 });
            await ctx.waitForText("Review skills before importing.", { timeoutMs: 10_000 });
            await ctx.eval(`(() => {
              const heading = [...document.querySelectorAll('h2')].find((entry) => (entry.textContent ?? '').trim() === 'Add plugin connection');
              const dialog = heading?.parentElement;
              if (dialog) dialog.scrollTop = 0;
              return Boolean(dialog);
            })()`);
          },
          assert: async () => {
            const capture = await capturedImportTraffic(ctx);
            const call = capture?.preview;
            ctx.assert(call?.responseStatus === 200, `Public preview did not return 200: ${JSON.stringify(call).slice(0, 800)}`);
            ctx.assert(typeof call.requestBody === "string", "The captured preview request had no JSON body.");
            const requestBody = JSON.parse(call.requestBody);
            ctx.assert(
              Object.keys(requestBody).length === 1 && requestBody.githubUrl === FIXTURE_URL,
              `Preview sent more than the public GitHub URL: ${JSON.stringify(requestBody)}`,
            );
            ctx.assert(!Object.keys(call.requestHeaders ?? {}).some((name) => name.includes("authorization")), "The browser attached an Authorization header to the public preview request.");

            const item = previewItem(capture);
            ctx.assert(item.repositoryFullName === FIXTURE_REPOSITORY, `Unexpected preview repository: ${item.repositoryFullName}`);
            ctx.assert(item.rootPath === FIXTURE_ROOT_PATH, `Unexpected preview root: ${item.rootPath}`);
            ctx.assert(item.sourceRevisionRef === FIXTURE_SHA, `Preview was not pinned to ${FIXTURE_SHA}: ${item.sourceRevisionRef}`);
            ctx.assert(Array.isArray(item.skills) && item.skills.length > 0, "Pinned Slack fixture did not expose its bundled skills.");

            const server = slackServer(item);
            ctx.assert(server.supported === true && server.url === "https://mcp.slack.com/mcp", `Slack was not a supported remote MCP: ${JSON.stringify(server).slice(0, 800)}`);
            const discovery = server.discovery;
            ctx.assert(isRecord(discovery) && discovery.auth?.kind === "oauth", `Slack OAuth was not discovered: ${JSON.stringify(discovery).slice(0, 800)}`);
            ctx.assert(discovery.oauth?.registration === "pre_registered", `Slack registration mode was not discovered: ${JSON.stringify(discovery.oauth)}`);
            ctx.assert(discovery.oauth?.clientIdRequired === true && discovery.oauth?.clientSecretRequired === true, `Required OAuth app values were incomplete: ${JSON.stringify(discovery.oauth)}`);
            ctx.assert(discovery.oauth?.scopesSource === "protected_resource", `Slack scopes did not come from protected-resource metadata: ${JSON.stringify(discovery.oauth)}`);
            ctx.assert(Array.isArray(discovery.oauth?.scopes) && discovery.oauth.scopes.includes(EXPECTED_SCOPE), `Expected scope ${EXPECTED_SCOPE} was not discovered: ${JSON.stringify(discovery.oauth?.scopes)}`);
            ctx.assert(discovery.inputs?.some((input) => input.placement === "oauth_client_id" && input.required && input.supported), "Required OAuth client ID input was not discoverable.");
            ctx.assert(discovery.inputs?.some((input) => input.placement === "oauth_client_secret" && input.required && input.supported && input.secret), "Required OAuth client secret input was not discoverable as a supported secret.");
            ctx.assert(!JSON.stringify(item).includes("1601185624273.8899143856786"), "The committed publisher OAuth client ID leaked into the public preview response.");

            const skillSelection = await ctx.eval(`(() => {
              const table = [...document.querySelectorAll('table')].find((entry) => (entry.querySelector('thead')?.innerText ?? '').toLowerCase().includes('skill'));
              const checkboxes = table ? [...table.querySelectorAll('tbody input[type="checkbox"]')] : [];
              return { count: checkboxes.length, selected: checkboxes.filter((entry) => entry.checked).length };
            })()`);
            ctx.assert(skillSelection.count > 0 && skillSelection.selected === 0, `Skills were not opt-in after preview: ${JSON.stringify(skillSelection)}`);
          },
          screenshot: {
            name: "immutable-bundle-preview",
            claim: "OpenWork shows the exact immutable GitHub revision and leaves executable skills unselected.",
            requireText: [
              FIXTURE_REPOSITORY,
              FIXTURE_ROOT_PATH,
              "at immutable revision",
              FIXTURE_REVISION_LABEL,
              "slack",
              "Review skills before importing.",
              "They are not selected by default",
            ],
            rejectText: ["Failed to preview GitHub plugin", "Something went wrong", "Plugin imported"],
          },
        });
      },
    },
    {
      name: "Frame 3 — Review discovered auth and scopes",
      run: async (ctx) => {
        await ctx.prove("The selected MCP explains its required OAuth values and requested permissions before configuration", {
          voiceover: vo[2],
          action: async () => {
            await selectSlackForReview(ctx);
            await ctx.waitForText(EXPECTED_SCOPE, { timeoutMs: 10_000 });
            await scrollConfigurationIntoView(ctx);
          },
          assert: async () => {
            const configuration = await ctx.eval(`(() => {
              const heading = [...document.querySelectorAll('p')].find((entry) => (entry.textContent ?? '').trim().toLowerCase() === 'configure slack');
              const card = heading?.closest('div.rounded-2xl');
              const labels = card ? [...card.querySelectorAll('label')] : [];
              const clientIdLabel = labels.find((entry) => (entry.innerText ?? '').trim().startsWith('Client ID'));
              const clientSecretLabel = labels.find((entry) => (entry.innerText ?? '').trim().startsWith('Client secret'));
              const selectTrigger = (labelText) => labels
                .find((entry) => (entry.querySelector('span')?.innerText ?? '').trim() === labelText)
                ?.querySelector('button[aria-haspopup="listbox"]');
              const authTrigger = selectTrigger('Authentication');
              const credentialTrigger = selectTrigger('Who signs in?');
              return {
                text: card?.innerText ?? '',
                clientIdValue: clientIdLabel?.querySelector('input')?.value ?? null,
                clientSecretType: clientSecretLabel?.querySelector('input')?.type ?? null,
                clientSecretValue: clientSecretLabel?.querySelector('input')?.value ?? null,
                authLabel: (authTrigger?.innerText ?? '').trim() || null,
                authLocked: authTrigger?.disabled ?? null,
                credentialLabel: (credentialTrigger?.innerText ?? '').trim() || null,
              };
            })()`);
            const normalizedConfigurationText = configuration.text.toLowerCase();
            ctx.assert(normalizedConfigurationText.includes("oauth app details needed"), `Discovery readiness was not visible: ${configuration.text}`);
            ctx.assert(normalizedConfigurationText.includes("oauth client id") && normalizedConfigurationText.includes("oauth client secret"), `Required inputs were not explained: ${configuration.text}`);
            ctx.assert(normalizedConfigurationText.includes("requested oauth permissions") && configuration.text.includes(EXPECTED_SCOPE), `Discovered scopes were not visible: ${configuration.text}`);
            ctx.assert(configuration.authLabel === "OAuth" && configuration.authLocked === true, `Verified OAuth was not selected and locked: ${JSON.stringify(configuration)}`);
            ctx.assert(configuration.credentialLabel === "Each user connects their own account", `Individual sign-in was not the default: ${JSON.stringify(configuration)}`);
            ctx.assert(configuration.clientIdValue === "", "A publisher or stored OAuth client ID was prefilled.");
            ctx.assert(configuration.clientSecretType === "password" && configuration.clientSecretValue === "", "The OAuth client secret field was not empty and protected.");
          },
          screenshot: {
            name: "discovered-oauth-values-and-scopes",
            claim: "The MCP review identifies OAuth app inputs, secure storage, account mode, and provider-advertised scopes without prefilling secrets.",
            requireText: [
              "Configure slack",
              "OAuth app details needed",
              "OPENWORK CAN COLLECT",
              "OAuth client ID",
              "OAuth client secret (stored securely)",
              "REQUESTED OAUTH PERMISSIONS",
              EXPECTED_SCOPE,
              "Who signs in?",
              "Each user connects their own account",
              "Client ID",
              "Client secret",
            ],
            rejectText: ["Plugin imported", "Failed to preview GitHub plugin"],
          },
        });
      },
    },
    {
      name: "Frame 4 — Review assignment without importing",
      run: async (ctx) => {
        await ctx.prove("Assignment rules are explicit and incomplete required auth keeps Import disabled", {
          voiceover: vo[3],
          action: async () => {
            await scrollAssignmentIntoView(ctx);
          },
          assert: async () => {
            const review = await ctx.eval(`(() => {
              const assignmentHeading = [...document.querySelectorAll('span')].find((entry) => (entry.textContent ?? '').trim() === 'Who can use this import?');
              const assignmentCard = assignmentHeading?.closest('div.rounded-2xl');
              const mode = (label) => [...(assignmentCard?.querySelectorAll('button') ?? [])].find((entry) => (entry.textContent ?? '').trim() === label);
              const importButton = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Import selected');
              const secretInputs = [...document.querySelectorAll('input[type="password"]')];
              return {
                assignmentText: assignmentCard?.innerText ?? '',
                everyoneSelected: mode('Everyone')?.getAttribute('aria-pressed') ?? null,
                teamsSelected: mode('Specific teams')?.getAttribute('aria-pressed') ?? null,
                peopleSelected: mode('Specific people')?.getAttribute('aria-pressed') ?? null,
                importDisabled: importButton?.disabled ?? null,
                passwordValues: secretInputs.map((entry) => entry.value),
              };
            })()`);
            ctx.assert(review.assignmentText.includes("This is the initial plugin, skill, and MCP assignment."), `Assignment policy copy was missing: ${review.assignmentText}`);
            ctx.assert(review.everyoneSelected === "true" && review.teamsSelected === "false" && review.peopleSelected === "false", `Default assignment was not explicit: ${JSON.stringify(review)}`);
            ctx.assert(review.importDisabled === true, "Import was enabled while required OAuth app values were blank.");
            ctx.assert(review.passwordValues.length > 0 && review.passwordValues.every((value) => value === ""), "A secret value was installed during preview.");

            const capture = await capturedImportTraffic(ctx);
            const importCalls = (capture?.calls ?? []).filter((call) => {
              try {
                const pathname = new URL(call.url, "http://openwork.local").pathname;
                return pathname.endsWith(IMPORT_PATH);
              } catch {
                return false;
              }
            });
            ctx.assert(importCalls.length === 0, `Preview/review submitted an import request: ${JSON.stringify(importCalls)}`);
          },
          screenshot: {
            name: "assignment-review-before-import",
            claim: "Everyone, team, and individual assignment choices are visible while missing required OAuth values safely block import.",
            requireText: [
              "Who can use this import?",
              "Everyone",
              "Specific teams",
              "Specific people",
              "This is the initial plugin, skill, and MCP assignment.",
              "Import selected",
            ],
            rejectText: ["Plugin imported", "Copy redirect URL", "Failed to import GitHub plugin"],
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        await ctx.eval(`(() => {
          if (window.__openworkEvalGithubImportOriginalFetch) {
            window.fetch = window.__openworkEvalGithubImportOriginalFetch;
          }
          delete window.__openworkEvalGithubImportOriginalFetch;
          return true;
        })()`);
      },
    },
  ],
};

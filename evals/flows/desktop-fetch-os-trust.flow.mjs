import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "desktop-fetch-os-trust";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const UNTRUSTED_ROOT_URL = "https://untrusted-root.badssl.com";
const INCOMPLETE_CHAIN_URL = "https://incomplete-chain.badssl.com";
const REMOTE_URL_INPUT = 'input[placeholder="https://worker.example.com"]';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const dialogTextExpression = `(() => {
  const dialogs = [...document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"]')];
  const dialog = dialogs.find((entry) => (entry.innerText ?? '').includes('Remote server details'))
    ?? dialogs[dialogs.length - 1]
    ?? document.body;
  return (dialog.innerText ?? '').replace(/\u00a0/g, ' ');
})()`;

async function navigateToSettingsTab(ctx, tab) {
  const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? ''");
  await ctx.navigateHash(workspaceId ? `/workspace/${workspaceId}/settings/${tab}` : `/settings/${tab}`);
  await ctx.waitFor(`window.location.hash.includes('/settings/${tab}')`, {
    timeoutMs: 30_000,
    label: `${tab} settings route`,
  });
  await ctx.waitFor("(document.body?.innerText ?? '').includes('OpenWork Cloud')", {
    timeoutMs: 30_000,
    label: "cloud settings surface mounted",
  });
}

async function closeStaleDialogs(ctx) {
  const clicked = await ctx.eval(`(() => {
    const text = document.body?.innerText ?? '';
    if (!text.includes('Remote server details') && !text.includes('Create Workspace')) return false;
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((candidate) => (candidate.textContent ?? '').trim() === 'Cancel')
      ?? buttons.find((candidate) => (candidate.textContent ?? '').trim() === 'Close');
    button?.click();
    return Boolean(button);
  })()`);
  await ctx.eval(`(() => {
    const first = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    const second = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(first);
    document.dispatchEvent(second);
    return true;
  })()`);
  if (clicked) {
    await ctx.waitFor(
      "(() => { const text = document.body?.innerText ?? ''; return !text.includes('Remote server details') && !text.includes('Create Workspace'); })()",
      { timeoutMs: 10_000, label: "stale dialog closed" },
    ).catch(() => {});
  }
}

async function dismissOpenWorkModelsDialog(ctx) {
  const clicked = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => (candidate.textContent ?? '').trim() === 'Continue without OpenWork Models');
    button?.click();
    return Boolean(button);
  })()`);
  if (clicked) await sleep(300);
}

async function openCloudAccount(ctx) {
  await navigateToSettingsTab(ctx, "cloud-account");
  await ctx.waitFor(
    `(() => {
      const text = document.body?.innerText ?? '';
      return text.includes('OpenWork Cloud') && (
        text.includes('Sign in') ||
        text.includes('Sign out') ||
        text.includes('Connected') ||
        text.includes('Select an organization') ||
        text.includes('Cloud account') ||
        text.includes('Cloud control plane URL')
      );
    })()`,
    { timeoutMs: 30_000, label: "cloud account controls" },
  );
}

async function returnToApp(ctx) {
  const inSettings = await ctx.eval("(document.body?.innerText ?? '').includes('Back to app')");
  if (inSettings) {
    await ctx.clickText("Back to app", { selector: "button", timeoutMs: 10_000 });
  }
  await dismissOpenWorkModelsDialog(ctx);
  await ctx.waitFor("(document.body?.innerText ?? '').includes('Add workspace')", {
    timeoutMs: 30_000,
    label: "session sidebar with Add workspace",
  });
}

async function openConnectRemoteDialog(ctx) {
  await returnToApp(ctx);
  await closeStaleDialogs(ctx);
  await dismissOpenWorkModelsDialog(ctx);
  await ctx.clickText("Add workspace", { selector: "button", timeoutMs: 30_000 });
  await ctx.waitFor(
    "(() => { const text = document.body?.innerText ?? ''; return text.includes('Create Workspace') || text.includes('Remote server details'); })()",
    { timeoutMs: 30_000, label: "create workspace dialog" },
  );
  const remoteScreenOpen = await ctx.eval("(document.body?.innerText ?? '').includes('Remote server details')");
  if (!remoteScreenOpen) {
    await ctx.clickText("Connect custom remote", { selector: "button", timeoutMs: 30_000 });
  }
  await ctx.waitForText("Remote server details", { timeoutMs: 30_000 });
  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(REMOTE_URL_INPUT)}))`, {
    timeoutMs: 10_000,
    label: "remote worker URL input",
  });
}

async function remoteDialogText(ctx) {
  return ctx.eval(dialogTextExpression);
}

async function visibleRemoteError(ctx) {
  return ctx.eval(`(() => {
    const text = ${dialogTextExpression};
    const lines = text.split(/\\n+/).map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => /ERR_CERT|fetch failed|OpenWork workspace discovery failed|Cannot reach|Health check|Unexpected token|404|Not Found/i.test(line))
      ?? lines.slice(-4).join(' ');
  })()`);
}

function readyToSubmitExpression(url) {
  return `(() => {
    const input = document.querySelector(${JSON.stringify(REMOTE_URL_INPUT)});
    const button = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Connect remote');
    return input?.value === ${JSON.stringify(url)} && button && !button.disabled;
  })()`;
}

export default {
  id: FLOW_ID,
  title: "Desktop remote calls trust the OS certificate path and name certificate failures instead of 'fetch failed'",
  kind: "user-facing",
  spec: "evals/voiceovers/desktop-fetch-os-trust.md",
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 60_000,
          label: "window.__openworkControl",
        });
        await closeStaleDialogs(ctx);
        await ctx.eval("location.reload()");
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 60_000,
          label: "window.__openworkControl after reset reload",
        });
        await closeStaleDialogs(ctx);

        await ctx.prove("The Cloud account settings surface opens cleanly", {
          claim: "Settings → Account renders the OpenWork Cloud account controls and does not show a generic fetch failure.",
          voiceover: vo[0],
          action: async () => {
            await openCloudAccount(ctx);
          },
          assert: async () => {
            await ctx.expectText("OpenWork Cloud");
            await ctx.expectNoText("fetch failed");
          },
          screenshot: {
            name: "cloud-account-ready",
            requireText: ["OpenWork Cloud"],
            rejectText: ["fetch failed"],
            hashIncludes: "/settings/cloud-account",
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The Connect remote dialog names an untrusted certificate failure", {
          claim: "When the worker certificate is not trusted by the OS, the dialog remains open and names ERR_CERT_AUTHORITY_INVALID instead of showing a bare fetch failure.",
          voiceover: vo[1],
          action: async () => {
            await openConnectRemoteDialog(ctx);
            await ctx.fill(REMOTE_URL_INPUT, UNTRUSTED_ROOT_URL);
            await ctx.waitFor(readyToSubmitExpression(UNTRUSTED_ROOT_URL), {
              timeoutMs: 10_000,
              label: "untrusted-root URL ready to submit",
            });
            await ctx.clickText("Connect remote", { selector: "button", timeoutMs: 10_000 });
            await ctx.waitFor(
              `${dialogTextExpression}.includes('ERR_CERT_AUTHORITY_INVALID')`,
              { timeoutMs: 30_000, label: "certificate-specific remote connection error" },
            );
          },
          assert: async () => {
            const dialogText = await remoteDialogText(ctx);
            const errorText = await visibleRemoteError(ctx);
            ctx.assert(dialogText.includes("ERR_CERT_AUTHORITY_INVALID"), `Expected ERR_CERT_AUTHORITY_INVALID, got: ${dialogText}`);
            ctx.assert(!/fetch failed/i.test(dialogText), `Remote error was still a generic fetch failure: ${dialogText}`);
            ctx.output("desktop-fetch-os-trust-frame-2-error.txt", errorText);
          },
          screenshot: {
            name: "remote-certificate-error",
            requireText: ["Remote server details", "ERR_CERT_AUTHORITY_INVALID"],
            rejectText: ["fetch failed"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The incomplete-chain endpoint passes TLS and fails only as a non-OpenWork server", {
          claim: "When the worker has an incomplete certificate chain, Chromium completes the trust path; the remaining error is protocol-level, with no ERR_CERT and no fetch failed.",
          voiceover: vo[2],
          action: async () => {
            await ctx.fill(REMOTE_URL_INPUT, INCOMPLETE_CHAIN_URL);
            await ctx.waitFor(readyToSubmitExpression(INCOMPLETE_CHAIN_URL), {
              timeoutMs: 10_000,
              label: "incomplete-chain URL ready to submit",
            });
            await ctx.clickText("Connect remote", { selector: "button", timeoutMs: 10_000 });
            await ctx.waitFor(
              `(() => {
                const text = ${dialogTextExpression};
                return !/ERR_CERT/i.test(text) && /OpenWork workspace discovery failed|Health check returned an unhealthy response|Health check failed|Cannot reach|Unexpected token|404|Not Found/i.test(text);
              })()`,
              { timeoutMs: 30_000, label: "non-TLS remote connection error" },
            );
          },
          assert: async () => {
            const dialogText = await remoteDialogText(ctx);
            const errorText = await visibleRemoteError(ctx);
            ctx.assert(!/ERR_CERT/i.test(dialogText), `Incomplete-chain probe still failed at certificate verification: ${dialogText}`);
            ctx.assert(!/fetch failed/i.test(dialogText), `Incomplete-chain probe regressed to fetch failed: ${dialogText}`);
            ctx.assert(
              /OpenWork workspace discovery failed|Health check returned an unhealthy response|Health check failed|Cannot reach|Unexpected token|404|Not Found/i.test(errorText),
              `Expected a protocol-level OpenWork server error, got: ${errorText}`,
            );
            ctx.output("desktop-fetch-os-trust-frame-3-error.txt", errorText);
          },
          screenshot: {
            name: "remote-incomplete-chain-non-tls-error",
            requireText: ["Remote server details", "OpenWork workspace discovery failed"],
            rejectText: ["fetch failed", "ERR_CERT"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Canceling returns the app to a healthy account page", {
          claim: "Canceling the failed connection returns to Account with the normal OpenWork Cloud controls still present and no generic fetch failure.",
          voiceover: vo[3],
          action: async () => {
            await ctx.clickText("Cancel", { selector: "button", timeoutMs: 10_000 });
            await ctx.waitFor("!(document.body?.innerText ?? '').includes('Remote server details')", {
              timeoutMs: 10_000,
              label: "remote dialog closed",
            });
            await openCloudAccount(ctx);
          },
          assert: async () => {
            await ctx.expectText("OpenWork Cloud");
            await ctx.expectNoText("Remote server details");
            await ctx.expectNoText("fetch failed");
          },
          screenshot: {
            name: "cloud-account-recovered",
            requireText: ["OpenWork Cloud"],
            rejectText: ["Remote server details", "fetch failed"],
            hashIncludes: "/settings/cloud-account",
          },
        });
      },
    },
  ],
};

import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timed } from "@openwork/timeline";
import { control, evalIn, waitFor } from "./desktop.ts";
import type { Surface } from "@openwork/cdp";

/**
 * The desktop signs in by opening the system browser and finishing there. To
 * observe that faithfully we capture what the app actually asks the OS to open
 * (via a PATH shim for xdg-open, which is what Electron's shell.openExternal
 * calls on Linux) rather than trusting that a browser appeared.
 *
 * Nothing here modifies the product: the app opens a URL exactly as it always
 * does; we just record where it pointed.
 */

export interface UrlCapture {
  /** Prepend to PATH when spawning the app. */
  binDir: string;
  /** Every URL the app asked the OS to open, oldest first. */
  opened(): Promise<string[]>;
  /** Wait for a URL matching a predicate, so a spec never races the handoff. */
  waitForUrl(match: (url: string) => boolean, opts?: { timeoutMs?: number }): Promise<string>;
}

export async function captureOpenedUrls(): Promise<UrlCapture> {
  const dir = await mkdtemp(join(tmpdir(), "openwork-open-external-"));
  const logPath = join(dir, "opened-urls.log");
  await writeFile(logPath, "", "utf8");
  const shim = join(dir, "xdg-open");
  await writeFile(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> ${JSON.stringify(logPath)}\nexit 0\n`, "utf8");
  await chmod(shim, 0o755);

  const opened = async (): Promise<string[]> => {
    const contents = await readFile(logPath, "utf8").catch(() => "");
    return contents.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  };

  return {
    binDir: dir,
    opened,
    async waitForUrl(match, { timeoutMs = 60_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let seen: string[] = [];
      while (Date.now() < deadline) {
        seen = await opened();
        const hit = seen.find((url) => match(url));
        if (hit) return hit;
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
      }
      throw new Error(`The app never asked to open a matching URL within ${timeoutMs}ms. Opened: ${seen.join(", ") || "<none>"}`);
    },
  };
}

/**
 * Sign in on a real den web page in a real browser, the way a person does.
 *
 * Observed shape: den auth is two steps, not one form. First an email-only
 * step ("Enter your email and we'll send you to the right sign-in step",
 * button "Next"); only after that does the password step appear (button
 * "Sign in"). There is no sign-up/sign-in toggle — the email step routes.
 */
export async function signInInBrowser(
  browser: Surface,
  url: string,
  credentials: { email: string; password: string },
): Promise<void> {
  await timed("browser.signIn", async () => {
    await evalIn(browser, `window.location.href = ${JSON.stringify(url)}`);
    await waitFor(browser, `(() => {
      if (document.querySelector('input[type="password"], input[name="password"]')) return true;
      const email = document.querySelector('input[type="email"], input[name="email"]');
      if (!email) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(email, ${JSON.stringify(credentials.email)});
      email.dispatchEvent(new Event("input", { bubbles: true }));
      const next = [...document.querySelectorAll("button")]
        .find((candidate) => /next|continue|sign ?in/i.test(candidate.textContent ?? "") && !candidate.disabled);
      if (!next) return false;
      next.click();
      return true;
    })()`, { timeoutMs: 120_000, label: "den email step submitted" });
    await waitFor(browser, `(() => {
      if (/signed in/i.test(document.body?.innerText ?? "")) return true;
      const password = document.querySelector('input[type="password"], input[name="password"]');
      if (!password) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(password, ${JSON.stringify(credentials.password)});
      password.dispatchEvent(new Event("input", { bubbles: true }));
      const submit = [...document.querySelectorAll("button")]
        .find((candidate) => /sign ?in|continue|log ?in/i.test(candidate.textContent ?? "") && !candidate.disabled);
      if (!submit) return false;
      submit.click();
      return true;
    })()`, { timeoutMs: 60_000, label: "den password step submitted" });
    // Signed in means the outcome page, not a submit in flight ("Working...").
    await waitFor(browser, `(() => {
      const text = document.body?.innerText ?? "";
      // Plain web sign-in redirects into the dashboard; handoff shows "signed in" or the openwork:// code.
      if (location.pathname.startsWith("/dashboard")) return true;
      if (/signed in/i.test(text)) return true;
      return [...document.querySelectorAll("input")]
        .some((input) => (input.value ?? "").startsWith("openwork://"));
    })()`, { timeoutMs: 60_000, label: "den sign-in outcome" });
  }, credentials.email);
}

/**
 * Read the deep link the browser is handed once sign-in completes.
 *
 * Observed shape: the app opens `<den>/?mode=sign-up&desktopAuth=1&desktopScheme=openwork`,
 * the person signs in there, and Den shows "You're signed in" with an
 * "Open OpenWork" button plus a readonly input holding the sign-in code —
 * the full `openwork://den-auth?grant=…&denBaseUrl=…` URL a person would
 * copy-paste into the app. Reading that input keeps the grant the real one
 * Den issued for this session.
 */
export async function readHandoffDeepLink(browser: Surface, { timeoutMs = 60_000 } = {}): Promise<string> {
  const found = await waitFor(browser, `(() => {
    const fromInput = [...document.querySelectorAll("input")]
      .map((input) => input.value)
      .find((value) => typeof value === "string" && value.startsWith("openwork://") && value.includes("grant="));
    if (fromInput) return fromInput;
    const fromAnchor = [...document.querySelectorAll('a[href^="openwork://"]')]
      .map((anchor) => anchor.getAttribute("href"))
      .find((href) => typeof href === "string" && href.includes("grant="));
    if (fromAnchor) return fromAnchor;
    const inText = (document.body?.innerText ?? "").match(/openwork:\\/\\/[^\\s"']+grant=[^\\s"']+/);
    return inText ? inText[0] : false;
  })()`, { timeoutMs, label: "handoff deep link in the browser" });
  if (typeof found !== "string") throw new Error("Could not read a handoff deep link from the browser page.");
  return found;
}

/**
 * Complete the hop back into the desktop.
 *
 * A real OS dispatches `openwork://den-auth?grant=…` to the app. A container has
 * no protocol handler registered, so we hand the grant to the product's own
 * documented entry point for exactly this situation (`auth.exchange-grant`,
 * described in-product as signing in with a handoff grant). The grant itself is
 * the real one the app generated and the browser session approved — only the OS
 * dispatch is bridged, and that is stated wherever this is used.
 */
export async function completeDesktopHandoff(app: Surface, deepLinkOrGrantUrl: string, denBaseUrl: string): Promise<string> {
  const url = new URL(deepLinkOrGrantUrl);
  const grant = url.searchParams.get("grant") ?? "";
  if (!grant) throw new Error(`No grant in the handoff URL: ${deepLinkOrGrantUrl}`);
  await control(app, "auth.exchange-grant", { grant, baseUrl: denBaseUrl });
  return grant;
}

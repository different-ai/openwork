import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { shots } from "./shots/index.ts";
import { REPO_ROOT } from "./surfaces.ts";

const DOCS_ROOT = join(REPO_ROOT, "packages/docs");
const IMAGES_ROOT = join(DOCS_ROOT, "images");
const SCENE_PREFIX = "packages/docs/images/";
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

/** Images maintained outside docs-shots, reviewed explicitly rather than silently ignored. */
const ALLOWLIST = new Set([
  "10thMarch-better-mcp-auth.gif",
  "10thMarch-model-picker.gif",
  "anthropic-key.png",
  "anthropic-openwork-key.png",
  "chatgpt-connect-provider-settings.png",
  "chatgpt-model-list.png",
  "chatgpt-model-selector.png",
  "chatgpt-new-session-cta.png",
  "chatgpt-openai-auth-login.png",
  "cloud-custom-llm-provider-detail.png",
  "cloud-dashboard-overview.png",
  "cloud-managed-llm-provider-detail.png",
  "cloud-mcp-connections-admin.png",
  "cloud-members-and-rbac-dashboard.png",
  "cloud-org-settings.png",
  "cloud-skill-hub-access-and-skills.png",
  "cloud-team-quickstart/01-signin-email.png",
  "cloud-team-quickstart/02-create-account.png",
  "cloud-team-quickstart/03-name-your-team.png",
  "cloud-team-quickstart/04-onboarding-checklist.png",
  "cloud-team-quickstart/05-invite-member-form.png",
  "cloud-team-quickstart/06-members-pending.png",
  "cloud-team-quickstart/07-join-org-amy.png",
  "cloud-team-quickstart/08-amy-welcome.png",
  "cloud-team-quickstart/09-create-team-sales.png",
  "cloud-team-quickstart/10-teams-list.png",
  "cloud-team-quickstart/11-plugins-overview.png",
  "cloud-team-quickstart/12-new-marketplace-dialog.png",
  "cloud-team-quickstart/13-create-plugin-top.png",
  "cloud-team-quickstart/14-create-plugin-skill-share.png",
  "cloud-team-quickstart/15-plugin-detail.png",
  "cloud-team-quickstart/16-security-check.png",
  "cloud-team-quickstart/17-marketplace-team-access.png",
  "cloud-team-quickstart/18-desktop-welcome.png",
  "cloud-team-quickstart/19-desktop-choose-org.png",
  "cloud-team-quickstart/20-desktop-org-resources.png",
  "cloud-team-quickstart/21-desktop-account-connected.png",
  "cloud-team-quickstart/22-desktop-marketplace-plugin.png",
  "cloud-team-quickstart/23-desktop-prompt.png",
  "cloud-team-quickstart/24-desktop-skill-result.png",
  "control-chrome-setup-modal.png",
  "deprecated/CleanShot2026-03-25at12.03.06@2x.png",
  "deprecated/CleanShot2026-03-25at12.11.56@2x.png",
  "deprecated/CleanShot2026-03-25at12.23.47@2x.png",
  "deprecated/den-landing-page.png",
  "deprecated/google-auth.png",
  "deprecated/image-6.png",
  "desktop-org-mcp-chat.png",
  "desktop-org-mcp-connected.png",
  "desktop-org-mcp-marketplace.png",
  "exa-search-toggle.png",
  "extensions-control-chrome-app.png",
  "get-started-add-remote-workspace.png",
  "get-started-cli-output.png",
  "improved-skills-march11th.gif",
  "infron-model-active.png",
  "infron-model-picker.png",
  "mcp-dynamic-registration-error.png",
  "mcp-oauth-approval-page.png",
  "ollama-added-as-provider.png",
  "ollama-custom-provider.png",
  "on-prem-branding/brand-assets-saved-in-den.png",
  "on-prem-branding/windows-taskbar-and-alt-tab.png",
  "openwork-providers.png",
  "sharing-create-link-dialog.png",
  "sharing-skill-share-page.png",
  "sharing-skills-list.png",
  "sharing-workspace-template-dialog.png",
  "skill-import-select-workspace.png",
  "skill-import-share-page.png",
  "skill-import-share-your-skill.png",
  "slack-connect-tokens.png",
  "slack-test-message-thread.png",
]);

function portable(path: string): string {
  return path.split(sep).join("/");
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const mdxFiles = (await filesUnder(DOCS_ROOT)).filter((path) => extname(path) === ".mdx");
const mdx = (await Promise.all(mdxFiles.map((path) => readFile(path, "utf8")))).join("\n");
const images = new Set(
  (await filesUnder(IMAGES_ROOT))
    .filter((path) => IMAGE_EXTENSIONS.has(extname(path).toLocaleLowerCase()))
    .map((path) => portable(relative(IMAGES_ROOT, path))),
);
const outputs = shots.map((shot) => shot.out.startsWith(SCENE_PREFIX) ? shot.out.slice(SCENE_PREFIX.length) : shot.out);
const outputSet = new Set(outputs);
const failures: string[] = [];

for (const shot of shots) {
  if (!shot.out.startsWith(SCENE_PREFIX)) failures.push(`${shot.id}: output is outside packages/docs/images: ${shot.out}`);
}
for (const output of outputs) {
  if (outputs.filter((candidate) => candidate === output).length > 1) failures.push(`duplicate scene output: ${output}`);
  if (!images.has(output)) failures.push(`scene output does not exist: ${output}`);
  if (!mdx.includes(`/images/${output}`)) failures.push(`scene output is not referenced by an mdx: ${output}`);
  if (ALLOWLIST.has(output)) failures.push(`scene output is also allowlisted: ${output}`);
}
for (const image of images) {
  if (!outputSet.has(image) && !ALLOWLIST.has(image)) failures.push(`image has no scene or allowlist entry: ${image}`);
}
for (const image of ALLOWLIST) {
  if (!images.has(image)) failures.push(`allowlist entry does not exist: ${image}`);
}

if (failures.length > 0) {
  console.error(`[docs-shots] manifest failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`[docs-shots] manifest ok: ${shots.length} scene outputs, ${ALLOWLIST.size} allowlisted images.`);
}

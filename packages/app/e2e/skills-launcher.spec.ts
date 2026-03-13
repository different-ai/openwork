import { expect, test } from "@playwright/test";

const bundleUrl = "https://share.openwork.software/b/test-skill";

test.beforeEach(async ({ page }) => {
  await page.route("**/b/test-skill*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("format") !== "json") {
      await route.fulfill({
        status: 404,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
        body: JSON.stringify({ message: "Not found" }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        type: "skill",
        name: "test-skill",
        content: "# Test skill\n\nUse this test skill.",
        description: "Playwright fixture skill",
      }),
    });
  });

  await page.goto("/skills-launcher-harness.html");
});

test("both create entry points open the launcher modal", async ({ page }) => {
  await page.getByRole("button", { name: "New skill" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create a skill" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByRole("button", { name: "Upload the skill" })).toBeVisible();
  await expect(createDialog.getByRole("button", { name: "Create/edit in skill editor" })).toBeVisible();
  await expect(createDialog.getByRole("button", { name: "Install from link" })).toBeVisible();
  await expect(createDialog.getByRole("button", { name: "Create a skill in chat" })).toBeVisible();

  await createDialog.getByRole("button", { name: "Close create skill modal" }).click();

  await page.getByRole("button", { name: "Create skill in chat" }).click();
  await expect(page.getByRole("dialog", { name: "Create a skill" })).toBeVisible();
});

test("launcher actions route into the shared flows", async ({ page }) => {
  await page.getByRole("button", { name: "New skill" }).click();
  let dialog = page.getByRole("dialog", { name: "Create a skill" });

  await dialog.getByRole("button", { name: "Upload the skill" }).click();
  await expect(page.getByTestId("import-count")).toHaveText("1");

  await page.getByRole("button", { name: "New skill" }).click();
  dialog = page.getByRole("dialog", { name: "Create a skill" });
  await dialog.getByRole("button", { name: "Create a skill in chat" }).click();
  await expect(page.getByTestId("session-count")).toHaveText("1");
  await expect(page.getByTestId("prompt-value")).toHaveText("/skill-creator");

  await page.getByRole("button", { name: "New skill" }).click();
  dialog = page.getByRole("dialog", { name: "Create a skill" });
  await dialog.getByRole("button", { name: "Create/edit in skill editor" }).click();
  const installDialog = page.getByRole("dialog", { name: "Install from link" });
  await expect(page.getByTestId("opened-url")).toHaveText("https://share.openworklabs.com");
  await expect(installDialog.getByText("Paste the share link from the editor to install it here.")).toBeVisible();

  await installDialog.getByLabel("Skill bundle link").fill(bundleUrl);
  await installDialog.getByRole("button", { name: "Preview" }).click();
  await expect(installDialog.getByText("Skill:")).toBeVisible();
  await installDialog.getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByTestId("saved-skills")).toContainText("test-skill");
});

test("toolbar install shortcut opens the shared install flow directly", async ({ page }) => {
  await page.getByRole("button", { name: "Install from link" }).last().click();
  const installDialog = page.getByRole("dialog", { name: "Install from link" });
  await expect(installDialog).toBeVisible();
  await expect(installDialog.getByText("Paste a skill bundle URL, preview it, then install.")).toBeVisible();
});

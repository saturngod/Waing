import { _electron as electron, expect, test } from "@playwright/test";

test("launches a sandboxed renderer with the typed preload bridge", async () => {
  const app = await electron.launch({ args: [process.cwd()], env: { ...process.env, WAING_E2E: "1" } });
  try {
    const page = await app.firstWindow();
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await page.reload();
    await expect(page).toHaveURL(/renderer\/index\.html$/);
    expect(rendererErrors).toEqual([]);
    await expect(page.getByRole("heading", { name: "Waing" })).toBeVisible();
    await expect(page.getByTestId("version")).toContainText("v0.1.0");
    await expect(page.getByText("Projects", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "E2E Workspace" })).toBeVisible();
    await expect(page.getByText("No tasks yet", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(page.locator(".context-sidebar")).toHaveCount(0);
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await expect(page.locator(".context-sidebar")).toBeVisible();
    await page.getByRole("button", { name: "New task" }).click();
    await expect(page.getByLabel("Message")).toBeFocused();
    await expect(page.getByRole("button", { name: "Attach files and images" })).toBeVisible();
    expect(await page.getByLabel("Message").evaluate((node) => getComputedStyle(node).fontFamily))
      .toBe(await page.locator("body").evaluate((node) => getComputedStyle(node).fontFamily));
    expect(await page.evaluate(() => typeof window.waing.app.info)).toBe("function");
    expect(await page.evaluate(() => typeof window.waing.system.openLink)).toBe("function");
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe(
      "undefined",
    );
    expect(await page.evaluate(() => typeof (window as unknown as { process?: unknown }).process)).toBe(
      "undefined",
    );
    expect(await page.evaluate(async () => {
      try { await window.waing.sessions.cancel(""); return false; } catch { return true; }
    })).toBe(true);
    expect(await page.evaluate(async () => {
      try {
        await window.waing.sessions.send({ projectId: "e2e-project", text: "unsafe attachment", agentId: "auto", mode: "execute",
          attachmentIds: ["00000000-0000-4000-8000-000000000000"] });
        return false;
      } catch { return true; }
    })).toBe(true);
    // The fake agent echoes the prompt, so this exercises Markdown rendering and raw-HTML escaping in one run.
    await page.getByLabel("Message").fill('Add a searchable project dashboard <img src=x onerror="window.__waingXss=true">\n\n'
      + "| Case | Result |\n|---|---|\n| Saved | `./images/hello.png` |\n\n- **bold** item");
    await page.getByRole("button", { name: "Preview route" }).click();
    const routingCard = page.getByRole("region", { name: "Routing decision" });
    await expect(routingCard).toBeVisible();
    await expect(routingCard).toContainText("Medium Level Task");
    await expect(routingCard).toContainText("92%");
    await page.getByRole("button", { name: "Send ↵" }).click();
    await expect(page.getByRole("region", { name: "Permission request" })).toBeVisible();
    await expect(page.locator(".activity-group.pending .activity-spinner")).toBeVisible();
    await expect(page.getByRole("status", { name: "Agent is working" })).toBeVisible();
    await expect(page.locator(".activity-group[open]")).toHaveCount(0);
    await expect(page.getByText("medium risk", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(page.getByTestId("last-event")).toHaveText("run.completed");
    await expect(page.getByRole("status", { name: "Agent is working" })).toHaveCount(0);
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __waingXss?: boolean }).__waingXss)).toBeUndefined();
    const markdown = page.locator(".chat-turn.agent .markdown");
    await expect(markdown.locator("table th").first()).toHaveText("Case");
    await expect(markdown.locator("table code")).toHaveText("./images/hello.png");
    await expect(markdown.locator("li strong")).toHaveText("bold");
    await expect(page.locator(".activity-group[open]")).toHaveCount(0);
    await page.locator(".activity-group summary").first().click();
    await expect(page.locator(".activity-group[open]")).toHaveCount(1);
    // The finished run is listed; opening it replays stored history and the context menu deletes it.
    const conversation = page.locator(".conversation-list button").first();
    await expect(conversation).toBeVisible();
    await expect(conversation).toContainText("Add a searchable project dashboard");
    await conversation.click();
    await expect(page.getByRole("region", { name: "Conversation" })).toContainText("Add a searchable project dashboard");
    await conversation.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete conversation" }).click();
    await expect(page.locator(".conversation-list button")).toHaveCount(0);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    const theme = page.getByRole("combobox", { name: "Theme" });
    await theme.selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await page.evaluate(() => window.localStorage.getItem("waing.theme"))).toBe("light");
    await theme.selectOption("system");
    const settingsSearch = page.getByRole("searchbox", { name: "Search settings" });
    await settingsSearch.fill("models");
    await expect(page.getByRole("button", { name: "Roles & routing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "General", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Roles & routing" }).click();
    await expect(page.getByRole("heading", { name: "Roles & routing" })).toBeVisible();
    await expect(page.getByText("Planning", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Planning mode", { exact: true })).toHaveValue("plan");
    await page.getByRole("combobox", { name: "Router agent" }).selectOption("fake");
    const routerModel = page.getByRole("combobox", { name: "Router model" });
    await expect(routerModel).toBeEnabled();
    await routerModel.fill("fake-1");
    const modelResults = page.getByRole("listbox", { name: "Router model results" });
    await expect(modelResults.getByRole("option", { name: "Fake 1" })).toBeVisible();
    await modelResults.getByRole("option", { name: "Fake 1" }).click();
    await expect(routerModel).toHaveValue("Fake 1");
    await page.getByRole("button", { name: "Providers" }).click();
    await expect(page.getByText("Provider status", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Diagnostics" }).click();
    await expect(page.getByRole("heading", { name: "Diagnostics", exact: true })).toBeVisible();
    // Settings takes the full page: no run inspector, no chat composer, and the run state moves into the topbar.
    await expect(page.locator(".inspector")).toHaveCount(0);
    await expect(page.locator(".composer")).toHaveCount(0);
    await expect(page.locator(".context-sidebar")).toHaveCount(0);
    await expect(page.locator(".rail")).toHaveCount(0);
    await expect(page.locator(".topbar")).toContainText("Applies to every project");
    await expect(page.locator(".run-pill")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

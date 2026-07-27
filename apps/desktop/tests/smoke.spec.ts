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
    expect(await page.evaluate(() => typeof window.waing.app.info)).toBe("function");
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe(
      "undefined",
    );
    expect(await page.evaluate(() => typeof (window as unknown as { process?: unknown }).process)).toBe(
      "undefined",
    );
    expect(await page.evaluate(async () => {
      try { await window.waing.sessions.cancel(""); return false; } catch { return true; }
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
    await expect(page.getByText("medium risk", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(page.getByTestId("last-event")).toHaveText("run.completed");
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __waingXss?: boolean }).__waingXss)).toBeUndefined();
    const markdown = page.locator(".chat-turn.agent .markdown");
    await expect(markdown.locator("table th").first()).toHaveText("Case");
    await expect(markdown.locator("table code")).toHaveText("./images/hello.png");
    await expect(markdown.locator("li strong")).toHaveText("bold");
    // The finished run is listed; opening it replays stored history and the context menu deletes it.
    const conversation = page.locator(".conversation-list button").first();
    await expect(conversation).toBeVisible();
    await conversation.click();
    await expect(page.getByRole("region", { name: "Conversation" })).toContainText("Add a searchable project dashboard");
    await conversation.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete conversation" }).click();
    await expect(page.locator(".conversation-list button")).toHaveCount(0);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("region", { name: "Settings" })).toContainText("Provider status");
    await expect(page.getByRole("region", { name: "Settings" })).toContainText("Diagnostics");
    // Settings takes the full page: no run inspector, no chat composer, and the run state moves into the topbar.
    await expect(page.locator(".inspector")).toHaveCount(0);
    await expect(page.locator(".composer")).toHaveCount(0);
    await expect(page.locator(".context-sidebar")).toHaveCount(0);
    await expect(page.locator(".topbar")).toContainText("Applies to every project");
    await expect(page.locator(".run-pill")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

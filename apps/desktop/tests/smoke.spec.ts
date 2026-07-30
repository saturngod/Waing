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
    await expect(page.getByRole("button", { name: "E2E Workspace", exact: true })).toBeVisible();
    await expect(page.getByText("No tasks yet", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(page.locator(".context-sidebar")).toHaveCount(0);
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await expect(page.locator(".context-sidebar")).toBeVisible();
    const workspaceWidthWithRightSidebar = await page.locator(".workspace").evaluate((node) => node.getBoundingClientRect().width);
    const rightSidebarWidth = await page.locator(".inspector").evaluate((node) => node.getBoundingClientRect().width);
    await page.getByRole("button", { name: "Hide right sidebar" }).click();
    await expect(page.locator(".inspector")).toHaveCount(0);
    await expect(page.locator(".workspace")).toHaveJSProperty("clientWidth", workspaceWidthWithRightSidebar + rightSidebarWidth);
    await page.getByRole("button", { name: "Show right sidebar" }).click();
    await expect(page.locator(".inspector")).toBeVisible();
    await expect(page.locator(".project-actions")).toHaveCount(0);
    await page.getByRole("button", { name: "E2E Workspace", exact: true }).click({ button: "right" });
    await expect(page.getByRole("menu", { name: "Project actions" })).toBeVisible();
    await page.locator(".menu-backdrop").click({ position: { x: 1, y: 1 } });
    await page.locator(".project-row-wrap").hover();
    await page.getByRole("button", { name: "Project actions for E2E Workspace" }).click();
    const projectMenu = page.getByRole("menu", { name: "Project actions" });
    await expect(projectMenu.getByRole("menuitem")).toHaveCount(3);
    await expect(projectMenu.getByRole("menuitem", { name: "New chat" })).toBeVisible();
    await expect(projectMenu.getByRole("menuitem", { name: "Reveal in Finder" })).toBeVisible();
    await expect(projectMenu.getByRole("menuitem", { name: "Remove" })).toBeVisible();
    await projectMenu.getByRole("menuitem", { name: "New chat" }).click();
    await expect(page.getByLabel("Message")).toBeFocused();
    await page.getByRole("button", { name: "New task" }).click();
    await expect(page.getByLabel("Message")).toBeFocused();
    await expect(page.getByRole("button", { name: "Attach files and images" })).toBeVisible();
    await page.getByLabel("Message").evaluate((textarea) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "clipboard.png", { type: "image/png" }));
      textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    await expect(page.getByRole("list", { name: "Attached files" })).toContainText("clipboard.png");
    await page.locator(".composer").evaluate((composer) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([255, 216, 255])], "dropped.jpg", { type: "image/jpeg" }));
      composer.dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true, cancelable: true }));
      composer.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await expect(page.getByRole("list", { name: "Attached files" })).toContainText("dropped.jpg");
    await page.getByRole("button", { name: "Remove clipboard.png" }).click();
    await page.getByRole("button", { name: "Remove dropped.jpg" }).click();
    await expect(page.getByRole("list", { name: "Attached files" })).toHaveCount(0);
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
    await page.getByRole("button", { name: "Send" }).click();
    // The routing decision is reported by the run itself, so the timeline is where it has to show up.
    const routedStep = page.locator(".chat-activity", { hasText: "Routed to Coder" });
    await expect(routedStep).toBeVisible();
    await expect(page.getByRole("region", { name: "Permission request" })).toBeVisible();
    await expect(page.getByTestId("last-event")).toBeHidden();
    await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow for session" })).toBeVisible();
    await expect(page.locator(".activity-group.pending .activity-spinner")).toBeVisible();
    await expect(page.getByRole("status", { name: "Agent is working" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Agent is working" })).toContainText(/Working \d+[smh]/);
    await expect(page.locator(".activity-group[open]")).toHaveCount(0);
    await expect(page.getByText("medium risk", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(page.getByTestId("last-event")).toHaveText("run.completed");
    await expect(page.getByRole("status", { name: "Agent is working" })).toHaveCount(0);
    await expect(page.locator(".activity-group.done summary").last()).toContainText(/Worked for \d+[smh]/);
    const latestDiff = page.locator(".diff-view");
    await expect(latestDiff).toContainText("src/dashboard.ts");
    await expect(latestDiff.locator(".diff-summary")).toContainText("+2");
    await expect(latestDiff.locator(".diff-summary")).toContainText("−1");
    await expect(latestDiff.locator(".diff-gap")).toContainText("9 unmodified lines");
    await expect(latestDiff.locator(".diff-line.deletion")).toContainText("return oldDashboard(title);");
    await expect(latestDiff.locator(".diff-line.addition").first()).toContainText("searchableDashboard(title)");
    await expect(latestDiff.locator(".diff-line-number.old", { hasText: "11" })).toBeVisible();
    await expect(latestDiff.locator(".diff-line-number.new", { hasText: "11" })).toBeVisible();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __waingXss?: boolean }).__waingXss)).toBeUndefined();
    const markdown = page.locator(".chat-turn.agent .markdown");
    await expect(page.locator(".chat-turn.agent .chat-author").first()).toContainText("Model: fake-1");
    await expect(page.locator(".chat-turn.agent .chat-author").first()).toContainText("Effort:");
    await expect(markdown.locator("table th").first()).toHaveText("Case");
    await expect(markdown.locator("table code").first()).toHaveText("./images/hello.png");
    await expect(markdown.locator("li strong").first()).toHaveText("bold");
    await expect(page.locator(".activity-group[open]")).toHaveCount(0);
    await page.locator(".activity-group summary").first().click();
    await expect(page.locator(".activity-group[open]")).toHaveCount(1);
    // The finished run is listed; opening it replays stored history and the context menu deletes it.
    const conversation = page.locator(".conversation-list button").first();
    await expect(conversation).toBeVisible();
    await expect(conversation).toContainText("Add a searchable project dashboard");
    const sidebarAlignment = await page.evaluate(() => {
      const projectRow = document.querySelector<HTMLElement>(".project-row")!;
      const projectName = projectRow.querySelector<HTMLElement>("strong")!;
      const taskRow = document.querySelector<HTMLElement>(".conversation-list button")!;
      const taskName = taskRow.querySelector<HTMLElement>("span")!;
      return { projectLeft: projectRow.getBoundingClientRect().left, taskLeft: taskRow.getBoundingClientRect().left,
        projectTextLeft: projectName.getBoundingClientRect().left, taskTextLeft: taskName.getBoundingClientRect().left,
        projectBackground: getComputedStyle(projectRow).backgroundColor };
    });
    expect(Math.abs(sidebarAlignment.projectLeft - sidebarAlignment.taskLeft)).toBeLessThan(1);
    expect(Math.abs(sidebarAlignment.projectTextLeft - sidebarAlignment.taskTextLeft)).toBeLessThan(1);
    expect(sidebarAlignment.projectBackground).toBe("rgba(0, 0, 0, 0)");
    await conversation.click();
    await expect(conversation).toHaveClass(/active/);
    expect(await conversation.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(sidebarAlignment.projectBackground);
    await expect(page.getByRole("region", { name: "Conversation" })).toContainText("Add a searchable project dashboard");
    // Sending from an open history item continues that app conversation instead of adding another sidebar row.
    await page.getByLabel("Message").fill("Continue from that plan");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".conversation-list button")).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Permission request" })).toBeVisible();
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(page.getByTestId("last-event")).toHaveText("run.completed");
    await expect(page.locator(".conversation-list button")).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Conversation" })).toContainText("Continue from that plan");
    await conversation.click({ button: "right" });
    const conversationMenu = page.getByRole("menu", { name: "Conversation actions" });
    await expect(conversationMenu.getByRole("menuitem")).toHaveCount(2);
    await expect(conversationMenu.getByRole("menuitem", { name: "Reveal in Finder" })).toBeVisible();
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
    await expect(page.getByRole("button", { name: "Agents" })).toBeVisible();
    await expect(page.getByRole("button", { name: "General", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Agents" }).click();
    await expect(page.getByRole("heading", { name: "Agents", level: 2 })).toBeVisible();
    await expect(page.getByText("Planner", { exact: true })).toBeVisible();
    await expect(page.getByText("Coder", { exact: true })).toBeVisible();
    const agentHeaderGap = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>(".agent-list-heading .primary")!;
      const list = document.querySelector<HTMLElement>(".agent-list")!;
      return list.getBoundingClientRect().top - button.getBoundingClientRect().bottom;
    });
    expect(agentHeaderGap).toBeGreaterThanOrEqual(12);
    const routerProvider = page.getByRole("combobox", { name: "Router provider" });
    await routerProvider.selectOption("fake");
    const routerModel = page.getByRole("combobox", { name: "Router model" });
    await expect(routerModel).toBeEnabled();
    await routerModel.selectOption("fake-1");
    await expect(routerModel).toHaveValue("fake-1");
    await page.getByRole("combobox", { name: "Router effort" }).selectOption("high");
    await page.getByRole("button", { name: "New agent" }).click();
    await expect(page.locator('input[value="New Agent"]')).toBeVisible();
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

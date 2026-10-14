import { test, expect } from "@playwright/test";
test("complete discovery → answer → actual browser fill → verify → approve → receipt → reply", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Your next opportunity." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Find internships", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Backend Engineering Intern",
      exact: true,
    }),
  ).toBeVisible({ timeout: 30000 });
  await page
    .getByText("Discovery started. Follow the agents in Activity.")
    .waitFor({ state: "hidden" });
  await page.screenshot({
    path: "test-results/dashboard.png",
    fullPage: false,
  });
  const card = page.locator("article").filter({
    has: page.getByRole("heading", {
      name: "Backend Engineering Intern",
      exact: true,
    }),
  });
  await card
    .getByRole("button", { name: "Shortlist Backend Engineering Intern" })
    .click();
  await card.getByRole("button", { name: "Prepare application" }).click();
  const modal = page.getByRole("dialog", { name: "Review application" });
  await expect(
    modal.getByText("A few details only you can answer."),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    modal.getByRole("button", { name: "Approve & submit" }),
  ).toHaveCount(0);
  await modal
    .getByLabel("Why are you interested in this internship?", { exact: true })
    .fill(
      "I built a campus API using Python and FastAPI and would like to contribute those skills.",
    );
  await modal
    .getByLabel("Are you currently a university student?", { exact: true })
    .selectOption("Yes");
  await modal.getByRole("button", { name: "Save changes and verify" }).click();
  await expect(
    modal.getByText("Independent verification completed"),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    modal.getByAltText("Actual filled application form before submission"),
  ).toBeVisible();
  await expect(
    modal.getByRole("button", { name: "Approve & submit" }),
  ).toBeEnabled();
  const dashboard = await (await page.request.get("/api/dashboard")).json();
  const application = dashboard.applications.find(
    (a: any) => a.listingId === "demo-backend",
  );
  expect(
    (
      await page.request.post(`/api/applications/${application.id}/approve`, {
        data: { packageHash: "stale-review" },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await page.request.post(
        `/api/applications/${application.id}/release-session`,
      )
    ).ok(),
  ).toBe(true);
  await modal.getByRole("button", { name: "Approve & submit" }).click();
  await expect(modal.getByText("Submission evidence")).toBeVisible({
    timeout: 30000,
  });
  await expect(modal.getByText(/Application reference: ACME-/)).toBeVisible();
  expect(
    (
      await page.request.post(`/api/applications/${application.id}/approve`, {
        data: { packageHash: application.packageHash },
      })
    ).status(),
  ).toBe(409);
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Responses", exact: false })
    .first()
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Interview invitation — controlled demo",
    }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("SIMULATED REPLY")).toBeVisible();
  await page.getByRole("button", { name: "Agent activity" }).click();
  await expect(
    page.getByText("submission verified", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/agent-activity.png",
    fullPage: true,
  });
});
test("responsive dashboard and persistent login", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Your next opportunity." }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your next opportunity." }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/mobile-dashboard.png",
    fullPage: true,
  });
});
test("background research does not block discovering new internships", async ({
  page,
}) => {
  await page.route("**/api/dashboard", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (response.ok())
      data.jobs.push({
        id: "scheduled-research",
        kind: "research_poll",
        status: "pending",
      });
    await route.fulfill({ response, json: data });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await expect(
    page.getByRole("heading", { name: "A fresh start." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Find internships", exact: true }).first(),
  ).toBeEnabled();
});

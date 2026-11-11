import { expect, test, type APIRequestContext } from "@playwright/test";
import { createVideo, signIn, uniqueEmail, uniqueIp } from "./helpers";

/** A fresh caller address per API call: the server trusts X-Forwarded-For in these runs, and the per-minute windows are shared. */
const asIp = (ip: string) => ({ headers: { "x-forwarded-for": ip } });

/** Wait for a stand-in render to finish (about a second, generously bounded). */
async function waitForDone(req: APIRequestContext, id: string, ip: string) {
  await expect
    .poll(async () => ((await (await req.get(`/api/jobs/${id}`, asIp(ip))).json()) as { state: string }).state, { timeout: 30_000 })
    .toBe("done");
}

test("signed-out visits land on the sign-in page, and the API answers 401", async ({ page, request }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/signin\?next=%2Fapp$/);
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.goto("/app/videos");
  await expect(page).toHaveURL(/\/signin\?next=%2Fapp%2Fvideos$/);
  const res = await request.get("/api/me/videos");
  expect(res.status()).toBe(401);
  expect((await res.json()).error).toBe("Sign in to make a video.");
});

test("a signed-in visit sees the dashboard with real empty states", async ({ page, baseURL }) => {
  const email = uniqueEmail();
  await signIn(page.request, baseURL!, email, uniqueIp());
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("You haven't made a video yet.")).toBeVisible();
  await expect(page.getByText("Nothing drawing right now.")).toBeVisible();
  await expect(page.locator(".app-count")).toContainText("/ 3");
  await expect(page.getByRole("link", { name: "My videos" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  await expect(page.getByTestId("app-user-menu")).toContainText(email);
});

test("a finished video lists with its poster and opens its page", async ({ page, baseURL }) => {
  const email = uniqueEmail();
  await signIn(page.request, baseURL!, email, uniqueIp());
  const created = await createVideo(page.request, baseURL!, "how dashboard lists work", uniqueIp());
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  const ip = uniqueIp();
  await waitForDone(page.request, id, ip);
  // the render filled the row, and the still frame landed after it
  let poster = "";
  await expect
    .poll(
      async () => {
        const l = await page.request.get("/api/me/videos", asIp(ip));
        const vs = ((await l.json()) as { videos: { id: string; title: string; urls: { poster?: string; mp4?: string; tldr?: string } }[] })
          .videos;
        const mine = vs.find((v) => v.id === id);
        expect(mine?.title).toBe("A stand-in explainer");
        expect(mine?.urls.mp4).toBeDefined();
        expect(mine?.urls.tldr).toBeUndefined();
        poster = mine?.urls.poster ?? "";
        if (!poster) return 0;
        return (await page.request.get(poster, asIp(ip))).status();
      },
      { timeout: 30_000 },
    )
    .toBe(200);
  await page.goto("/app/videos");
  await expect(page.getByRole("link", { name: "A stand-in explainer" })).toBeVisible();
  await expect(page.locator(".app-thumb img").first()).toBeVisible();
  await page.goto("/app/videos?q=stand-in");
  await expect(page.getByRole("link", { name: "A stand-in explainer" })).toBeVisible();
  await page.goto("/app/videos?q=no-such-video-zzz");
  await expect(page.getByText("No videos match")).toBeVisible();
  await page.goto("/app/videos?view=grid");
  await expect(page.locator(".app-recent .app-vid")).toHaveCount(1);
  await page.goto(`/app/videos/${id}`);
  await expect(page.getByRole("link", { name: "Download mp4" })).toBeVisible({ timeout: 15_000 });
});

test("deleting a video from the list removes it and its files", async ({ page, baseURL }) => {
  const email = uniqueEmail();
  await signIn(page.request, baseURL!, email, uniqueIp());
  const created = await createVideo(page.request, baseURL!, "how dashboard deletes work", uniqueIp());
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  const ip = uniqueIp();
  await waitForDone(page.request, id, ip);
  await page.goto("/app/videos");
  const row = page.locator("tbody tr", { hasText: "A stand-in explainer" });
  await row.getByRole("button", { name: "Delete" }).click();
  await row.getByRole("button", { name: "Yes, delete" }).click();
  await expect(page.getByText("You haven't made a video yet.")).toBeVisible();
  const list = await page.request.get("/api/me/videos", asIp(ip));
  expect(((await list.json()) as { videos: unknown[] }).videos).toEqual([]);
  expect((await page.request.get(`/api/jobs/${id}`, asIp(ip))).status()).toBe(404);
});

test("one account cannot delete another account's video", async ({ request, baseURL }) => {
  const emailA = uniqueEmail();
  await signIn(request, baseURL!, emailA, uniqueIp());
  const created = await createVideo(request, baseURL!, "how dashboard ownership works", uniqueIp());
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  const emailB = uniqueEmail();
  await signIn(request, baseURL!, emailB, uniqueIp());
  const ip = uniqueIp();
  const del = await request.delete(`/api/me/videos/${id}`, { headers: { "x-forwarded-for": ip } });
  expect(del.status()).toBe(404);
  const list = await request.get("/api/me/videos", asIp(ip));
  expect(((await list.json()) as { videos: { id: string }[] }).videos.find((v) => v.id === id)).toBeUndefined();
  expect((await request.get(`/api/jobs/${id}`, asIp(ip))).status()).toBe(200);
});

test("signing out from the sidebar lands on the landing page", async ({ page, baseURL }) => {
  const email = uniqueEmail();
  await signIn(page.request, baseURL!, email, uniqueIp());
  await page.goto("/app");
  await page.getByTestId("app-user-menu").click();
  await page.getByTestId("app-sign-out").click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  const config = await page.request.get("/api/auth-config");
  expect(((await config.json()) as { user: unknown }).user).toBeNull();
});

test("the landing prompt sends signed-out visits to sign-in, then the editor with the prompt", async ({ page, baseURL }) => {
  await page.goto("/");
  await expect(page.getByText("Sign in to make a video.").first()).toBeVisible();
  await page.getByLabel("Link or topic to explain").first().fill("how DNS works");
  await page
    .getByRole("button", { name: /Explain it/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/signin\?next=%2Fapp%2Fnew%3Fprompt%3Dhow%2520DNS%2520works$/);
  const email = uniqueEmail();
  await signIn(page.request, baseURL!, email, uniqueIp());
  // signed in now: the sign-in page forwards to the editor carrying the prompt
  await page.reload();
  await expect(page).toHaveURL(/\/app\/new\?prompt=how%20DNS%20works$/);
  await expect(page.getByLabel("Link or topic to explain")).toHaveValue("how DNS works");
});

test("a signed-in visit to the landing page goes straight to the dashboard", async ({ page, baseURL }) => {
  const email = uniqueEmail();
  await signIn(page.request, baseURL!, email, uniqueIp());
  await page.goto("/");
  await expect(page).toHaveURL(/\/app$/);
});

const WIDTHS = [1440, 1024, 768, 390];
const ROUTES = ["/app", "/app/new", "/app/videos", "/app/connect", "/app/usage", "/app/settings"];

for (const width of WIDTHS) {
  test(`the dashboard fits ${width}px without sideways scroll`, async ({ page, baseURL }) => {
    const email = uniqueEmail();
    await signIn(page.request, baseURL!, email, uniqueIp());
    await page.setViewportSize({ width, height: 900 });
    for (const route of ROUTES) {
      await page.goto(route);
      await expect(page.locator("h1").first()).toBeVisible();
      const overflow = await page.evaluate(
        () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });
}

for (const width of [768, 390]) {
  test(`every list action is on screen at ${width}px, with no sideways scroll inside the table`, async ({ page, baseURL }) => {
    const email = uniqueEmail();
    await signIn(page.request, baseURL!, email, uniqueIp());
    const created = await createVideo(page.request, baseURL!, "how narrow lists work", uniqueIp());
    expect(created.ok()).toBe(true);
    const { id } = (await created.json()) as { id: string };
    await waitForDone(page.request, id, uniqueIp());
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/app/videos");
    const row = page.locator("tbody tr", { hasText: "A stand-in explainer" });
    await expect(row).toBeVisible();
    for (const name of ["Open", "Follow-up"]) await expect(row.getByRole("link", { name, exact: true })).toBeInViewport({ ratio: 1 });
    await expect(row.getByRole("button", { name: "Delete" })).toBeInViewport({ ratio: 1 });
    const hidden = await page.locator(".app-tscroll").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(hidden).toBeLessThanOrEqual(1);
  });
}

test("the sidebar becomes a drawer on phones", async ({ page, baseURL }) => {
  const email = uniqueEmail();
  await signIn(page.request, baseURL!, email, uniqueIp());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  const menu = page.getByRole("button", { name: "Open menu" });
  await expect(menu).toBeVisible();
  await expect(page.locator("aside.app-side")).not.toBeVisible();
  await menu.click();
  await expect(page.locator("aside.app-side")).toBeVisible();
  await page.getByRole("button", { name: "Close menu" }).click();
  await expect(page.locator("aside.app-side")).not.toBeVisible();
});

/**
 * tests/integration/admin-announcement-routes.test.ts
 *
 * The two doors to the announcement table, and the one public door out of it.
 *
 * Three properties are what this file exists for:
 *
 *  - **The admin doors are admin only.** `403` for anonymous and for a
 *    signed-in non-admin, on every method — an announcement is published in the
 *    operator's voice, so "anybody may write one" is impersonation, not a
 *    moderation problem.
 *  - **PATCH merges.** The switch in the list sends `{enabled:false}` and
 *    nothing else; a route that demanded the title back would make the one
 *    action on that row the most expensive one in the table.
 *  - **The public door leaks nothing.** Only active rows, and only the public
 *    shape: no `enabled`, no `updatedAt`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetDbForTest } from "@/lib/db/sqlite";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import { createUser } from "@/lib/db/users";
import { createAnnouncement } from "@/lib/db/announcements";

import { GET as listGET, POST as createPOST } from "@/app/api/admin/announcements/route";
import {
  DELETE as oneDELETE,
  GET as oneGET,
  PATCH as onePATCH,
} from "@/app/api/admin/announcements/[id]/route";
import { GET as publicGET } from "@/app/api/announcements/route";

async function login(store: InMemoryCookieStore, id: string, role: "admin" | "user"): Promise<void> {
  const s = await getSessionFromStore(store);
  s.userId = id;
  s.username = role;
  s.role = role;
  await s.save();
}

async function asAdmin(): Promise<void> {
  const admin = await createUser({ username: "admin", password: "pw-123456", role: "admin" });
  currentStore = new InMemoryCookieStore();
  await login(currentStore, admin.id, "admin");
}

async function asUser(): Promise<void> {
  const user = await createUser({ username: "someone", password: "pw-123456", role: "user" });
  currentStore = new InMemoryCookieStore();
  await login(currentStore, user.id, "user");
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function json(body: unknown, method = "POST"): Request {
  return new Request("http://localhost/api/admin/announcements", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  __resetDbForTest();
  currentStore = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authorization", () => {
  it("refuses anonymous access on every admin method", async () => {
    currentStore = new InMemoryCookieStore();
    expect((await listGET()).status).toBe(403);
    expect((await createPOST(json({ title: "T", body: "B" }))).status).toBe(403);
    expect((await oneGET(new Request("http://localhost"), ctx("x"))).status).toBe(403);
    expect((await onePATCH(json({ title: "T" }, "PATCH"), ctx("x"))).status).toBe(403);
    expect((await oneDELETE(new Request("http://localhost"), ctx("x"))).status).toBe(403);
  });

  it("refuses a signed-in non-admin", async () => {
    await asUser();
    expect((await listGET()).status).toBe(403);
    expect((await createPOST(json({ title: "T", body: "B" }))).status).toBe(403);
    const body = (await (await createPOST(json({ title: "T", body: "B" }))).json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("forbidden");
  });

  it("leaves the public read open to anyone, signed in or not", async () => {
    currentStore = new InMemoryCookieStore();
    const res = await publicGET();
    expect(res.status).toBe(200);
  });
});

describe("GET /api/admin/announcements", () => {
  it("lists every row, including the ones no reader can see", async () => {
    await asAdmin();
    await createAnnouncement({ title: "live", body: "B" });
    await createAnnouncement({ title: "draft", body: "B", startsAt: "2099-01-01T00:00" });
    await createAnnouncement({ title: "off", body: "B", enabled: false });

    const body = (await (await listGET()).json()) as {
      data: { announcements: Array<{ title: string }> };
    };
    expect(body.data.announcements.map((a) => a.title).sort()).toEqual(["draft", "live", "off"]);
  });
});

describe("POST /api/admin/announcements", () => {
  it("writes a row and answers with it", async () => {
    await asAdmin();
    const res = await createPOST(
      json({ title: "Maintenance", body: "At 20:00", level: "warning", pinned: true }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { announcement: { id: string; title: string; level: string; pinned: boolean } };
    };
    expect(body.data.announcement.title).toBe("Maintenance");
    expect(body.data.announcement.level).toBe("warning");
    expect(body.data.announcement.pinned).toBe(true);
    expect(body.data.announcement.id).toBeTruthy();
  });

  it("rejects a malformed body with the messages, not a bare 400", async () => {
    await asAdmin();
    const res = await createPOST(json({ title: "", body: "B" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toMatch(/at least 1 character/);
  });

  it("rejects JSON it cannot parse", async () => {
    await asAdmin();
    const res = await createPOST(
      new Request("http://localhost/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_json");
  });

  it("rejects an unknown field rather than ignoring it", async () => {
    // `.strict()`: a typo quietly dropped is an announcement published without
    // the schedule the operator thought they had set.
    await asAdmin();
    const res = await createPOST(json({ title: "T", body: "B", startAt: "2026-01-01T00:00" }));
    expect(res.status).toBe(400);
  });

  it("reports an inverted window as a 400 with the sentence the repository wrote", async () => {
    await asAdmin();
    const res = await createPOST(
      json({
        title: "T",
        body: "B",
        startsAt: "2026-02-01T00:00",
        endsAt: "2026-01-01T00:00",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/end time must be after the start time/);
  });

  it("accepts an empty string for a cleared bound", async () => {
    // What `<input type="datetime-local">` submits when it is cleared.
    await asAdmin();
    const res = await createPOST(json({ title: "T", body: "B", startsAt: "", endsAt: "" }));
    expect(res.status).toBe(200);
  });

  it("refuses a bound that does not parse", async () => {
    await asAdmin();
    const res = await createPOST(json({ title: "T", body: "B", endsAt: "tomorrow" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/valid date and time/);
  });
});

describe("GET /api/admin/announcements/[id]", () => {
  it("returns the row", async () => {
    await asAdmin();
    const row = await createAnnouncement({ title: "T", body: "B" });
    const res = await oneGET(new Request("http://localhost"), ctx(row.id));
    expect(res.status).toBe(200);
  });

  it("404s for a row that is not there", async () => {
    await asAdmin();
    const res = await oneGET(new Request("http://localhost"), ctx("nope"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

describe("PATCH /api/admin/announcements/[id]", () => {
  it("flips the switch without the caller resending anything", async () => {
    await asAdmin();
    const row = await createAnnouncement({ title: "T", body: "B" });
    const res = await onePATCH(json({ enabled: false }, "PATCH"), ctx(row.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { announcement: { enabled: boolean; title: string } } };
    expect(body.data.announcement.enabled).toBe(false);
    expect(body.data.announcement.title).toBe("T");
  });

  it("retitles without touching the switch", async () => {
    await asAdmin();
    const row = await createAnnouncement({ title: "old", body: "B", enabled: false });
    const body = (await (
      await onePATCH(json({ title: "new" }, "PATCH"), ctx(row.id))
    ).json()) as { data: { announcement: { title: string; enabled: boolean } } };
    expect(body.data.announcement.title).toBe("new");
    expect(body.data.announcement.enabled).toBe(false);
  });

  it("404s and writes nothing for a row that is not there", async () => {
    await asAdmin();
    const res = await onePATCH(json({ enabled: false }, "PATCH"), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("validates the merged row, so the edit path cannot invert a window", async () => {
    await asAdmin();
    const row = await createAnnouncement({
      title: "T",
      body: "B",
      startsAt: "2026-02-01T00:00",
    });
    const res = await onePATCH(json({ endsAt: "2026-01-01T00:00" }, "PATCH"), ctx(row.id));
    expect(res.status).toBe(400);
  });

  it("rejects a level outside the four", async () => {
    await asAdmin();
    const row = await createAnnouncement({ title: "T", body: "B" });
    const res = await onePATCH(json({ level: "critical" }, "PATCH"), ctx(row.id));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/admin/announcements/[id]", () => {
  it("removes the row and names it in the answer", async () => {
    await asAdmin();
    const row = await createAnnouncement({ title: "T", body: "B" });
    const res = await oneDELETE(new Request("http://localhost"), ctx(row.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deletedAnnouncementId: string } };
    expect(body.data.deletedAnnouncementId).toBe(row.id);
  });

  it("404s for a second delete", async () => {
    await asAdmin();
    const row = await createAnnouncement({ title: "T", body: "B" });
    await oneDELETE(new Request("http://localhost"), ctx(row.id));
    expect((await oneDELETE(new Request("http://localhost"), ctx(row.id))).status).toBe(404);
  });
});

describe("GET /api/announcements (public)", () => {
  it("returns only what is live right now", async () => {
    await createAnnouncement({ title: "live", body: "B" });
    await createAnnouncement({ title: "draft", body: "B", startsAt: "2099-01-01T00:00" });
    await createAnnouncement({ title: "off", body: "B", enabled: false });
    await createAnnouncement({ title: "over", body: "B", endsAt: "2020-01-01T00:00" });

    const body = (await (await publicGET()).json()) as {
      data: { announcements: Array<{ title: string }> };
    };
    expect(body.data.announcements.map((a) => a.title)).toEqual(["live"]);
  });

  it("strips the operator's fields", async () => {
    await createAnnouncement({ title: "live", body: "B", level: "success" });
    const text = await (await publicGET()).text();
    expect(text).not.toContain("enabled");
    expect(text).not.toContain("updatedAt");
    expect(text).toContain("success");
  });

  it("answers with an empty list, not an error, when there is nothing to say", async () => {
    const res = await publicGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { announcements: unknown[] } };
    expect(body.data.announcements).toEqual([]);
  });

  it("is not cached: a notice has to be able to say the gateway is down now", async () => {
    const route = await import("@/app/api/announcements/route");
    expect(route.dynamic).toBe("force-dynamic");
  });
});
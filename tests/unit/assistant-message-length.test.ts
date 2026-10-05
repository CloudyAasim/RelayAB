/**
 * There is no ceiling on the message, and there still is a floor.
 *
 * The 8,000-character limit was about two percent of the smallest model on this
 * deployment, and it fired before the request left — so the application refused
 * work the model had already agreed to do, and a person pasting a stack trace
 * got a refusal instead of a reading. A character count cannot even tell two
 * languages apart: the same 8,000 characters is three or four times as many
 * tokens in Chinese as in English, and the user is never told they are being
 * charged differently.
 *
 * The window is the model's to enforce, and it enforces it better than a
 * constant can: it knows how much of the window this conversation has already
 * spent, and it can say so in a way that names the model. So the request goes
 * out and whatever the upstream says is reported like any other upstream
 * failure.
 *
 * The floor is the part worth guarding. Removing a ceiling is a one-line change,
 * and the check that keeps an empty turn from creating a thread is the one next
 * to it. They were removed together once, by accident, in the change that made
 * this test necessary.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = readFileSync(
  join(process.cwd(), "src", "app", "api", "assistant", "chat", "route.ts"),
  "utf-8",
);

describe("the message has no ceiling", () => {
  it("and no leftover constant standing in for one", () => {
    expect(ROUTE).not.toMatch(/MAX_MESSAGE_CHARS/);
    expect(ROUTE).not.toMatch(/消息过长/);
    // The code the limit used to return, in case it is still served by something.
    expect(ROUTE).not.toMatch(/code: "too_long"/);
  });

  it("a long message is not refused here", () => {
    // What a refusal looked like: measured in characters, before the request was
    // ever built. Nothing of that shape is left.
    expect(ROUTE).not.toMatch(/\.length\s*>\s*\d+.*消息/);
  });

  it("the attachment ceiling is still there, because it is a different thing", () => {
    // 25 MB is a size the upload path and the media route agree on, and it has a
    // reason. Long content belongs here rather than in the text box, which is
    // the whole reason removing the text ceiling costs nothing.
    expect(ROUTE).toMatch(/MAX_ATTACHMENT_BYTES = 25 \* 1024 \* 1024/);
  });
});

describe("an empty turn is still refused", () => {
  it("a turn of nothing but a picture is fine", () => {
    expect(ROUTE).toMatch(
      /if \(!message && uploads\.files\.length === 0\) \{[\s\S]{0,200}消息不能为空/,
    );
  });

  it("and it happens before anything is created", () => {
    // Otherwise a mis-click leaves a question mark in the user's history and a
    // thread with nothing in it. Anchored on the settings read the turn needs,
    // not on a function name: the check is "before the work", and naming one
    // caller would make the test pass while a different path started first.
    const check = ROUTE.indexOf("消息不能为空");
    const work = ROUTE.indexOf("getSettings().then", check);
    expect(check).toBeGreaterThan(-1);
    expect(work, "the empty check runs after the turn starts").toBeGreaterThan(check);
  });
});

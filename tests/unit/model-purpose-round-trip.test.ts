/**
 * tests/unit/model-purpose-round-trip.test.ts
 *
 * The model purpose has to survive every write path.
 *
 * The providers page writes the **whole** model table back on save. So a form
 * that did not carry the purpose would quietly file a vector model under the
 * conversation models — every time somebody saved the provider, for a reason
 * that has nothing to do with the purpose and would not be noticed by anyone
 * looking at that page.
 *
 * The purpose is declared on the model notes page, not on the providers page.
 * That makes the round trip through here the only thing standing between the
 * declaration and a silent reset.
 */
import { describe, it, expect } from "vitest";
import {
  rowsFromProvider,
  rowsToPayload,
  newModelRow,
} from "@/app/(admin)/admin/providers/model-rows";

describe("the purpose survives the providers page", () => {
  it("carries a declared purpose from the stored config back into the payload", () => {
    // The bug this file exists for. An operator sets `embedding` on the model
    // notes page, then saves the provider for an unrelated reason — a price, a
    // context window. The provider form rewrites every model row, so a purpose
    // it did not carry would be gone, and the vector model would move itself
    // into the conversation group of every account's model list.
    const stored = {
      "text-embedding-3-small": {
        upstreamId: "text-embedding-3-small",
        contextLength: 8191,
        purpose: "embedding" as const,
      },
    };
    const rows = rowsFromProvider({ "text-embedding-3-small": "text-embedding-3-small" }, stored);
    expect(rows[0].purpose).toBe("embedding");

    const payload = rowsToPayload(rows);
    expect(payload.modelConfigs["text-embedding-3-small"].purpose).toBe("embedding");
  });

  it("writes a conversation model for a row that declares nothing", () => {
    // A row written before the field existed is a conversation model, and
    // saying so is better than leaving the field out: the route merges, so an
    // absent field would keep whatever was stored — which is right for the
    // model notes page and wrong here, where the whole table is replaced.
    const rows = rowsFromProvider({ "MiniMax-M3": "MiniMax-M3" }, {});
    expect(rows[0].purpose).toBe("chat");

    const payload = rowsToPayload(rows);
    expect(payload.modelConfigs["MiniMax-M3"].purpose).toBe("chat");
  });

  it("and a new row starts as a conversation model", () => {
    // The purpose is declared elsewhere, so a row born here makes the same
    // claim the rest of the form makes: it answers.
    expect(newModelRow().purpose).toBe("chat");
  });
});

/**
 * tests/unit/reasoning-level-sanitise.test.ts
 *
 * A level is a value the model accepts. `http_code` is a field in the error that
 * said so, and it was stored as a level for nine models on one deployment.
 *
 * The parser that did it is gone, so this is about the write path: a closed
 * list of envelope names, applied where a person types them and where the
 * assistant's change lands, and nowhere else — a stored value is read back as
 * it is, because refusing to parse a provider row over one bad label would take
 * it offline to complain about a label.
 */
import { describe, it, expect } from "vitest";
import { sanitizeLevelList } from "@/lib/providers/reasoning-levels";

describe("what may be stored as a thinking level", () => {
  it("keeps the vendor's own names, in the vendor's order", () => {
    expect(sanitizeLevelList(["low", "medium", "high", "xhigh", "max"])).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // Order is information: a vendor lists them quietest to loudest.
    expect(sanitizeLevelList(["minimal", "xhigh"])).toEqual(["minimal", "xhigh"]);
  });

  it("drops the field names that came out of an error envelope", () => {
    // The exact shape that was stored.
    expect(
      sanitizeLevelList([
        "http_code",
        "request_id",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("and the rest of an envelope's vocabulary, whatever it is called", () => {
    for (const name of [
      "code",
      "status",
      "status_code",
      "trace_id",
      "id",
      "type",
      "message",
      "detail",
      "error",
      "error_code",
      "param",
      "field",
      "reason",
    ]) {
      expect(sanitizeLevelList([name, "high"]), `${name} survived`).toEqual(["high"]);
    }
  });

  it("however it is capitalised", () => {
    expect(sanitizeLevelList(["HTTP_CODE", "Request_Id", "high"])).toEqual(["high"]);
  });

  it("without touching a name that merely looks like one", () => {
    // A shape test would eventually reject a real level. This is a list.
    expect(sanitizeLevelList(["coder", "highcode", "status-quo", "none"])).toEqual([
      "coder",
      "highcode",
      "status-quo",
      "none",
    ]);
  });

  it("drops blanks and duplicates, and tolerates nothing at all", () => {
    expect(sanitizeLevelList(["  ", "low", "low", ""])).toEqual(["low"]);
    expect(sanitizeLevelList([])).toEqual([]);
    expect(sanitizeLevelList(null)).toEqual([]);
    expect(sanitizeLevelList(undefined)).toEqual([]);
  });
});

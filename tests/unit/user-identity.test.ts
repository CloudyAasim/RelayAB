import { describe, it, expect } from "vitest";
import { formatUserIdentity } from "@/lib/user-identity";

describe("formatUserIdentity", () => {
  it("returns the username when there is no usable display name", () => {
    expect(formatUserIdentity("alice")).toBe("alice");
    expect(formatUserIdentity("alice", null)).toBe("alice");
    expect(formatUserIdentity("alice", "")).toBe("alice");
    expect(formatUserIdentity("alice", "   ")).toBe("alice");
  });

  it("appends a distinct display name in parentheses", () => {
    expect(formatUserIdentity("alice", "Alice Wang")).toBe("alice (Alice Wang)");
  });

  it("does not repeat an alias identical to the username", () => {
    expect(formatUserIdentity("alice", "alice")).toBe("alice");
  });

  it("trims the alias", () => {
    expect(formatUserIdentity("alice", "  Alice Wang  ")).toBe("alice (Alice Wang)");
  });

  it("always keeps the username first, never hidden behind the alias", () => {
    const label = formatUserIdentity("bob", "Manager");
    expect(label.startsWith("bob")).toBe(true);
    expect(label).toContain("Manager");
  });
});

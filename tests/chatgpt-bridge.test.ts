import { describe, expect, it } from "vitest";
import { phaseRank } from "@/lib/chatgpt/bridge";

describe("ChatGPT phase ordering", () => {
  it("never treats an earlier phase as progress", () => {
    expect(phaseRank("opening")).toBeLessThan(phaseRank("typing"));
    expect(phaseRank("typing")).toBeLessThan(phaseRank("waiting"));
    expect(phaseRank("waiting")).toBeLessThan(phaseRank("copying"));
    expect(phaseRank("copying")).toBeLessThan(phaseRank("done"));
    expect(phaseRank(undefined)).toBe(-1);
  });
});
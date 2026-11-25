import { describe, expect, it } from "vitest";
import { parseModelJson } from "@/server/services/chatgpt.service";

describe("parseModelJson", () => {
  it("reads a fenced JSON answer", () => {
    expect(parseModelJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it("reads JSON with a sentence before it", () => {
    expect(parseModelJson('Here is the document you asked for:\n{"ok":true}\nDone.')).toEqual({
      ok: true,
    });
  });

  it("does not stop at a brace inside a string", () => {
    expect(parseModelJson('Result: {"body":"a } brace","ok":true}')).toEqual({
      body: "a } brace",
      ok: true,
    });
  });

  it("explains a non-JSON answer instead of returning half an object", () => {
    expect(() => parseModelJson("I could not write that.")).toThrow(/did not return a JSON answer/);
  });
});

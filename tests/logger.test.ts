import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

/**
 * The console is part of the product surface here: the people running the
 * dashboard asked for two signals and nothing else. This locks that contract,
 * including error-level noise from internal steps.
 */
describe("logger allow-list", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints only a received lead and a received ChatGPT answer", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logger.info("leads_received", { count: 1 });
    logger.info("chatgpt_response_received", { jobId: "job-1" });
    logger.info("api_request", { path: "/api/leads" });
    logger.warn("api_open_dev_mode");
    logger.error("api_unhandled_error", { requestId: "req-1" });

    const lines = [...log.mock.calls, ...error.mock.calls].map((args) =>
      String(args[0]),
    );
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.includes("leads_received"))).toBe(true);
    expect(lines.some((line) => line.includes("chatgpt_response_received"))).toBe(true);
    expect(lines.some((line) => line.includes("api_request"))).toBe(false);
    expect(lines.some((line) => line.includes("api_unhandled_error"))).toBe(false);
  });
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The provider layer: which model answers, what rides the wire, and what a
 * failure sounds like.
 *
 * Puter is reached over its driver HTTP contract rather than the SDK, so the
 * exact body is asserted here — `content-type: text/plain;actually=json` and an
 * in-body `auth_token` are both surprising, and a silent change to either would
 * look like an authentication bug at 09:00 with a batch half-sent.
 */

const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-long-enough-for-tests",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-long-enough-for-tests",
  NEXT_PUBLIC_APP_URL: "https://track.example.com",
  EMAIL_PROVIDER: "smtp",
  SMTP_HOST: "smtp.example.com",
};

function applyEnv(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    process.env[key] = value;
  }
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  for (const key of Object.keys(process.env)) {
    if (/SUPABASE|APP_URL|EMAIL_PROVIDER|SMTP_|GROQ_|PUTER_|AI_|AUTO_ENRICH|CRON_/.test(key)) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function load(overrides: Record<string, string> = {}) {
  applyEnv(overrides);
  const ai = await import("@/server/services/ai");
  return { ai, env: await import("@/lib/env") };
}

function jsonResponse(payload: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const PUTER_OK = {
  message: { role: "assistant", content: '{"ok":true,"title":"Proposal"}' },
  finish_reason: "stop",
  usageDetails: { inputTokens: 120, outputTokens: 480, reasoningTokens: 32 },
  usage: { cost: 4200 },
};

describe("provider resolution", () => {
  it("prefers Puter when its token exists, under auto", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "a-puter-token-value", GROQ_API_KEY: "gq-key-long-enough" });
    const status = ai.aiStatus();
    expect(status.provider).toBe("puter");
    expect(status.requested).toBe("auto");
    expect(status.model).toBe("anthropic/claude-sonnet-5-5");
    expect(status.fallbackModel).toBe("openai/gpt-6.2-sol");
  });

  it("falls back to Groq when only the Groq key exists", async () => {
    const { ai } = await load({ GROQ_API_KEY: "gq-key-long-enough" });
    expect(ai.aiStatus().provider).toBe("groq");
    expect(ai.aiStatus().model).toBe("openai/gpt-oss-120b");
  });

  it("lets the fallback answer when the preferred provider has no credential", async () => {
    const { ai } = await load({ AI_PROVIDER: "puter", GROQ_API_KEY: "gq-key-long-enough" });
    const status = ai.aiStatus();
    // A dead or missing Puter token must not lose the lead — but the panel has
    // to say that Groq is being used, because it is a different account's money.
    expect(status.provider).toBe("groq");
    expect(status.chain.map((leg) => leg.provider)).toEqual(["groq"]);
    expect(status.reason).toMatch(/PUTER_AUTH_TOKEN is not set/);
  });

  it("stays strict when AI_FALLBACK_PROVIDER=none", async () => {
    const { ai } = await load({
      AI_PROVIDER: "puter",
      AI_FALLBACK_PROVIDER: "none",
      GROQ_API_KEY: "gq-key-long-enough",
    });
    expect(ai.aiStatus().provider).toBe("none");
    await expect(
      ai.aiJson({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/No AI provider configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours AI_PROVIDER=none", async () => {
    const { ai } = await load({
      AI_PROVIDER: "none",
      PUTER_AUTH_TOKEN: "a-puter-token-value",
      GROQ_API_KEY: "gq-key-long-enough",
    });
    expect(ai.aiStatus().provider).toBe("none");
  });

  it("shares one completion budget across both providers", async () => {
    const { ai } = await load({
      PUTER_AUTH_TOKEN: "a-puter-token-value",
      AI_MAX_TOKENS: "9000",
      GROQ_API_KEY: "gq-key-long-enough",
    });
    expect(ai.aiStatus().maxTokens).toBe(9000);

    // Without AI_MAX_TOKENS the pipeline keeps the budget it had before this
    // option existed, so an existing deployment does not silently change.
    delete process.env.AI_MAX_TOKENS;
    vi.resetModules();
    const { ai: without } = await load({
      PUTER_AUTH_TOKEN: "a-puter-token-value",
      GROQ_API_KEY: "gq-key-long-enough",
    });
    expect(without.aiStatus().maxTokens).toBe(12000);
  });
});

describe("PUTER wire contract", () => {
  it("posts the driver envelope with the token in the body, not a header", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token" });
    fetchMock.mockResolvedValue(jsonResponse(PUTER_OK));

    await ai.aiJson({
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "write it" },
      ],
      temperature: 0.2,
      maxTokens: 4000,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.puter.com/drivers/call");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("text/plain;actually=json");
    expect(init.headers).not.toHaveProperty("authorization");

    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      interface: "puter-chat-completion",
      driver: "ai-chat",
      method: "complete",
      auth_token: "secret-puter-token",
    });
    expect(body.args.messages).toHaveLength(2);
    expect(body.args.model).toBe("anthropic/claude-sonnet-5-5");
    expect(body.args.max_tokens).toBe(4000);
    expect(body.args.temperature).toBe(0.2);
    // Normalized so the primary and the fallback answer in one shape.
    expect(body.args.normalize).toBe(true);
  });

  it("omits a reasoning effort the caller did not ask for", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token" });
    fetchMock.mockResolvedValue(jsonResponse(PUTER_OK));

    await ai.aiJson({ messages: [{ role: "user", content: "hi" }] });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.args.reasoning_effort).toBeUndefined();
  });

  it("reads a vendor-native content array as well as a string", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token" });
    fetchMock.mockResolvedValue(
      jsonResponse({
        message: { content: [{ type: "text", text: '{"a":' }, { type: "text", text: "1}" }] },
        usageDetails: { inputTokens: 5, outputTokens: 6 },
      }),
    );

    const result = await ai.aiJson<{ a: number }>({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.data).toEqual({ a: 1 });
  });

  it("tolerates a fenced JSON answer", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token" });
    fetchMock.mockResolvedValue(
      jsonResponse({ message: { content: "```json\n{\"a\":2}\n```" } }),
    );
    expect((await ai.aiJson<{ a: number }>({ messages: [{ role: "user", content: "hi" }] })).data).toEqual({
      a: 2,
    });
  });

  it("reports the real charge when Puter provides one", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token" });
    fetchMock.mockResolvedValue(jsonResponse(PUTER_OK));

    const result = await ai.aiJson({ messages: [{ role: "user", content: "hi" }] });
    // 4200 microcents, and provider-neutral token counts.
    expect(result.usage).toMatchObject({
      prompt_tokens: 120,
      completion_tokens: 480,
      reasoning_tokens: 32,
      cost_usd: 0.0042,
    });
    expect(ai.aiCostOf(result.usage)).toEqual({ usd: 0.0042, basis: "billed" });
  });

  it("labels a Groq-shaped usage as an estimate", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token" });
    expect(
      ai.aiCostOf({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }),
    ).toMatchObject({ basis: "estimated" });
  });

  it("returns the provider and model it actually used", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token" });
    fetchMock.mockResolvedValue(jsonResponse(PUTER_OK));
    const result = await ai.aiJson({ messages: [{ role: "user", content: "hi" }] });
    expect(result.provider).toBe("puter");
    expect(result.model).toBe("anthropic/claude-sonnet-5-5");
  });
});

describe("failure reporting", () => {
  async function failing(status: number, body: unknown, overrides: Record<string, string> = {}) {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token", ...overrides });
    // A fresh Response per call: a body can only be read once, and the fallback
    // ladder reads the answer of the first attempt before trying the next model.
    fetchMock.mockImplementation(
      () =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    return ai
      .aiJson({ messages: [{ role: "user", content: "hi" }] })
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  }

  it("tells the operator to re-login on a revoked token", async () => {
    const message = await failing(401, { code: "token_auth_failed", message: "Authentication failed" });
    expect(message).toMatch(/puter login/i);
  });

  it("names the allowance, not the model, when credit is out", async () => {
    const message = await failing(402, { code: "insufficient_funds", message: "no credit" });
    expect(message).toMatch(/monthly allowance/);
    expect(message).toMatch(/AI_PROVIDER=groq/);
  });

  it("says so when the model id is wrong", async () => {
    const message = await failing(404, { code: "model_not_found", message: "no such model" });
    expect(message).toMatch(/PUTER_MODEL/);
  });

  it("explains a mid-JSON truncation as a budget problem", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token" });
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ message: { content: '{"a": 1, "b":' }, finish_reason: "length" }),
      ),
    );
    await expect(ai.aiJson({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /AI_MAX_TOKENS/,
    );
  });

  it("does not retry a 429 into the same window", async () => {
    const message = await failing(429, { code: "too_many_requests", message: "slow down" });
    expect(message).toMatch(/rate limited/i);
    // One primary + one fallback attempt, then it stops rather than hammering.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("survives a gateway that answers HTML", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token" });
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response("<html>502 bad gateway</html>", { status: 502 })),
    );
    await expect(ai.aiJson({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /not JSON|Puter/,
    );
  });

  it("maps an aborted slow call to a timeout sentence", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token", AI_TIMEOUT_MS: "20000" });
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    // The client's own abort timer is what turns a hung call into a sentence,
    // so the test advances that clock instead of waiting twenty seconds.
    vi.useFakeTimers();
    const pending = ai.aiJson({ messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(20_000);
    vi.useRealTimers();
    await expect(pending).rejects.toThrow(/timed out after 20000ms/);
  });
});

describe("the fallback model", () => {
  it("is tried once when the first refuses", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token" });
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ message: { content: "" }, finish_reason: "content_filter" }),
      )
      .mockResolvedValueOnce(jsonResponse({ message: { content: '{"ok":true}' } }));

    const result = await ai.aiJson<{ ok: boolean }>({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.data).toEqual({ ok: true });
    expect(result.model).toBe("openai/gpt-6.2-sol");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is not tried when the problem is the account, not the model", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token" });
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: "insufficient_funds" }), { status: 402 }),
      ),
    );
    await expect(ai.aiJson({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /allowance/,
    );
    // A second model would bill the same empty balance.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is skipped when it is the same model", async () => {
    const { ai } = await load({
      PUTER_AUTH_TOKEN: "secret-puter-token",
      PUTER_FALLBACK_MODEL: "anthropic/claude-sonnet-5-5",
    });
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ message: { content: "" }, finish_reason: "content_filter" }),
      ),
    );
    await expect(ai.aiJson({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /declined|no text/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ingest defaults", () => {
  it("does not generate on arrival unless told to", async () => {
    const { env } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token" });
    expect(env.getServerEnv().AUTO_ENRICH_LEADS).toBe(false);
    expect(env.aiConfigured()).toBe(true);
  });

  it("warns when auto-enrich is switched back on", async () => {
    const { env } = await load({ AUTO_ENRICH_LEADS: "true", PUTER_AUTH_TOKEN: "secret-puter-token" });
    expect(env.getServerEnv().AUTO_ENRICH_LEADS).toBe(true);
    expect(env.getEnvDiagnostics().join("\n")).toMatch(/spends tokens on a document nobody has read/);
  });
});

describe("Groq request body", () => {
  /**
   * gpt-oss answers `reasoning_effort: "none"` with a 400 that names no
   * parameter the compatibility ladder can walk, so "no reasoning" has to be
   * expressed by leaving the field out. The budget tuner picks "none" on a
   * tight allowance, which would otherwise fail every generation.
   */
  it("omits reasoning_effort instead of sending a value the model rejects", async () => {
    const { ai } = await load({ GROQ_API_KEY: "gq-key-long-enough", AI_PROVIDER: "groq" });
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      ),
    );

    await ai.aiJson({
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "none",
      maxTokens: 64,
    });

    const bodies = fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>,
    );
    expect(bodies[0]).toMatchObject({ model: "openai/gpt-oss-120b" });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    expect(bodies[0]).toHaveProperty("max_completion_tokens");
  });

  it("does send low/medium/high", async () => {
    const { ai } = await load({ GROQ_API_KEY: "gq-key-long-enough", AI_PROVIDER: "groq" });
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      ),
    );
    await ai.aiJson({ messages: [{ role: "user", content: "hi" }], reasoningEffort: "low" });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.reasoning_effort).toBe("low");
  });
});

describe("provider fallback chain", () => {
  /**
   * The point of the chain: Puter is preferred because it costs us nothing and
   * has no per-minute wall, but every way it can fail — spent allowance, revoked
   * token, refused prompt, dead gateway — must end with the document written by
   * Groq and the reviewer told that it happened.
   */
  const groqAnswer = () =>
    jsonResponse({
      choices: [{ message: { content: '{"ok":true,"by":"groq"}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
      model: "openai/gpt-oss-120b",
    });

  it("answers with Groq when Puter is out of credit", async () => {
    const { ai } = await load({
      PUTER_AUTH_TOKEN: "secret-puter-token",
      GROQ_API_KEY: "gq-key-long-enough",
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "insufficient_funds" }), { status: 402 }),
      )
      .mockImplementationOnce(() => Promise.resolve(groqAnswer()));

    const result = await ai.aiJson<{ by: string }>({
      messages: [{ role: "user", content: "write it" }],
    });

    expect(result.provider).toBe("groq");
    expect(result.data.by).toBe("groq");
    expect(result.fellBackFrom).toBe("puter");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts?.[0]?.error).toMatch(/allowance/);
    // Puter first, then Groq — and only two calls, not a retry storm.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("answers with Groq when the Puter token was revoked", async () => {
    const { ai } = await load({
      PUTER_AUTH_TOKEN: "secret-puter-token",
      GROQ_API_KEY: "gq-key-long-enough",
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "token_auth_failed" }), { status: 401 }),
      )
      .mockImplementationOnce(() => Promise.resolve(groqAnswer()));

    const result = await ai.aiJson({ messages: [{ role: "user", content: "write it" }] });
    expect(result.provider).toBe("groq");
    expect(result.attempts?.[0]?.error).toMatch(/puter login/);
  });

  it("answers with Groq when the whole Puter gateway is down", async () => {
    const { ai } = await load({
      PUTER_AUTH_TOKEN: "secret-puter-token",
      GROQ_API_KEY: "gq-key-long-enough",
    });
    fetchMock
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockImplementationOnce(() => Promise.resolve(groqAnswer()));

    const result = await ai.aiJson({ messages: [{ role: "user", content: "write it" }] });
    expect(result.provider).toBe("groq");
    expect(result.attempts?.[0]?.error).toMatch(/Puter request failed/);
  });

  it("names every provider when both fail, because the fixes differ", async () => {
    const { ai } = await load({
      PUTER_AUTH_TOKEN: "secret-puter-token",
      GROQ_API_KEY: "gq-key-long-enough",
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "insufficient_funds" }), { status: 402 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "daily limit reached" } }), { status: 429 }),
      );

    const message = await ai
      .aiJson({ messages: [{ role: "user", content: "write it" }] })
      .catch((error: Error) => error.message);

    expect(message).toMatch(/Neither provider could write this document/);
    expect(message).toMatch(/puter:.*allowance/);
    expect(message).toMatch(/groq:/);
  });

  it("skips the fallback when the time budget is already gone", async () => {
    const { ai } = await load({
      PUTER_AUTH_TOKEN: "secret-puter-token",
      GROQ_API_KEY: "gq-key-long-enough",
      // The whole call has 20 s and a leg needs at least 60 s to be worth
      // starting, so after Puter fails there is no room for Groq.
      AI_MAX_TOTAL_MS: "20000",
      AI_MIN_ATTEMPT_MS: "60000",
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: "insufficient_funds" }), { status: 402 }),
    );

    const message = await ai
      .aiJson({ messages: [{ role: "user", content: "write it" }] })
      .catch((error: Error) => error.message);

    // Groq was never called: half a generation is worse than none, because the
    // function would have been killed mid-JSON.
    expect(message).toMatch(/Neither provider/);
    expect(message).toMatch(/budget was already spent/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to a provider that is not configured", async () => {
    const { ai } = await load({ PUTER_AUTH_TOKEN: "secret-puter-token" });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: "insufficient_funds" }), { status: 402 }),
    );
    const message = await ai
      .aiJson({ messages: [{ role: "user", content: "write it" }] })
      .catch((error: Error) => error.message);
    expect(message).toMatch(/puter:/);
    expect(message).not.toMatch(/groq:/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the chain in the probe so a failure is explainable", async () => {
    const { probe } = await import("@/server/services/ai/probe").then((m) => ({ probe: m.probeAi }));
    const { ai } = await load({
      PUTER_AUTH_TOKEN: "secret-puter-token",
      GROQ_API_KEY: "gq-key-long-enough",
    });
    void ai;
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "insufficient_funds" }), { status: 402 }),
      )
      .mockImplementationOnce(() => Promise.resolve(groqAnswer()));

    const result = await probe({ prompt: "hi" });
    expect(result.ok).toBe(true);
    expect(result.chain).toEqual(["puter", "groq"]);
    expect(result.attempts[0]?.provider).toBe("puter");
  });
});

describe("model overrides across the chain", () => {
  /**
   * A model id names a model *inside one provider*. `anthropic/claude-sonnet-5-5`
   * is not a Groq model, and Groq answers it with a 404 — so carrying a
   * Puter-shaped override into the Groq leg turned every fallback into a second
   * failure. Found by probing a live deployment with a revoked Puter token.
   */
  it("applies an explicit model only to the leg it was written for", async () => {
    const { ai } = await load({
      PUTER_AUTH_TOKEN: "secret-puter-token",
      GROQ_API_KEY: "gq-key-long-enough",
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "token_auth_failed" }), { status: 401 }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 5 },
          }),
        ),
      );

    await ai.aiJson({
      messages: [{ role: "user", content: "write it" }],
      model: "anthropic/claude-opus-5-5",
    });

    const bodies = fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>,
    );
    // First leg: the override rides, in Puter's args envelope.
    expect((bodies[0].args as Record<string, unknown>).model).toBe("anthropic/claude-opus-5-5");
    // Second leg: Groq's own configured model, never the Puter id.
    expect(bodies[1].model).toBe("openai/gpt-oss-120b");
  });

  it("keeps the chain's own models when no override is given", async () => {
    const { ai } = await load({
      PUTER_AUTH_TOKEN: "secret-puter-token",
      GROQ_API_KEY: "gq-key-long-enough",
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "insufficient_funds" }), { status: 402 }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 5 },
          }),
        ),
      );

    const result = await ai.aiJson({ messages: [{ role: "user", content: "write it" }] });
    expect(result.model).toBe("openai/gpt-oss-120b");
    expect(result.fellBackFrom).toBe("puter");
  });
});

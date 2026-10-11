import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../../src/store/memory-store.js";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  applyReviewOperations,
  buildDirectReviewCompletionOptions,
  isAuthRejection,
  parseReviewOperations,
  resolveReviewModels,
  runDirectMemoryCompletion,
} from "../../src/handlers/review-memory-ops.js";
import { DatabaseManager } from "../../src/store/db.js";
import { reconcileMarkdownMemoryScope } from "../../src/store/sqlite-memory-store.js";
import {
  DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
  DIRECT_CORRECTION_SYSTEM_PROMPT,
  DIRECT_FLUSH_SYSTEM_PROMPT,
  DIRECT_REVIEW_SYSTEM_PROMPT,
} from "../../src/constants.js";

function mockModel(reasoning: boolean): Model<Api> {
  return {
    id: "test-model",
    provider: "test",
    api: "openai-completions",
    reasoning,
  } as Model<Api>;
}

describe("buildDirectReviewCompletionOptions", () => {
  it("forwards auth env and preserves reasoning level", () => {
    const signal = new AbortController().signal;
    const options = buildDirectReviewCompletionOptions(
      mockModel(true),
      {
        apiKey: "sk-test",
        headers: { "X-Test": "1" },
        env: { CUSTOM_BASE_URL: "https://proxy.example" },
      },
      "minimal",
      signal,
    );

    assert.strictEqual(options.apiKey, "sk-test");
    assert.deepStrictEqual(options.headers, { "X-Test": "1" });
    assert.deepStrictEqual(options.env, { CUSTOM_BASE_URL: "https://proxy.example" });
    assert.strictEqual(options.reasoning, "minimal");
    assert.strictEqual(options.signal, signal);
  });

  it("omits reasoning when thinking is off or model does not support it", () => {
    const signal = new AbortController().signal;
    const off = buildDirectReviewCompletionOptions(
      mockModel(true),
      { apiKey: "sk-test" },
      "off",
      signal,
    );
    const nonReasoning = buildDirectReviewCompletionOptions(
      mockModel(false),
      { apiKey: "sk-test" },
      "high",
      signal,
    );

    assert.strictEqual(off.reasoning, undefined);
    assert.strictEqual(nonReasoning.reasoning, undefined);
  });
});

describe("parseReviewOperations", () => {
  it("parses valid JSON operations", () => {
    const parsed = parseReviewOperations(JSON.stringify({
      operations: [
        { action: "add", target: "memory", content: "uses pnpm" },
      ],
    }));

    assert.deepStrictEqual(parsed, [
      { action: "add", target: "memory", content: "uses pnpm" },
    ]);
  });

  it("returns empty array for nothing-to-save text", () => {
    assert.deepStrictEqual(parseReviewOperations("Nothing to save."), []);
  });

  it("returns null for invalid JSON", () => {
    assert.strictEqual(parseReviewOperations("not json at all"), null);
  });

  it("extracts JSON from fenced blocks", () => {
    const parsed = parseReviewOperations("```json\n{\"operations\":[{\"action\":\"add\",\"target\":\"user\",\"content\":\"prefers dark mode\"}]}\n```");
    assert.deepStrictEqual(parsed, [
      { action: "add", target: "user", content: "prefers dark mode" },
    ]);
  });
});

describe("applyReviewOperations", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-ops-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("applies add operations to memory store", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();

    const result = await applyReviewOperations(store, null, [
      { action: "add", target: "memory", content: "prefers biome over eslint" },
    ]);

    assert.strictEqual(result.appliedCount, 1);
    assert.strictEqual(result.skippedCount, 0);
    assert.ok(store.getMemoryEntries().some((entry) => entry.includes("prefers biome over eslint")));
  });

  it("skips project operations when project store is unavailable", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();

    const result = await applyReviewOperations(store, null, [
      { action: "add", target: "project", content: "api uses /v2" },
    ]);

    assert.strictEqual(result.appliedCount, 0);
    assert.strictEqual(result.skippedCount, 1);
  });

  it("uses the in-lock mutation observer as the sole SQLite reconciliation path", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();

    const dbManager = new DatabaseManager(path.join(tmpDir, "db"));
    const originalGetDb = dbManager.getDb.bind(dbManager);
    let insideObserver = false;
    (dbManager as any).getDb = () => {
      if (!insideObserver) throw new Error("out-of-lock SQLite access");
      return originalGetDb();
    };
    store.setMutationObserver((_target, entries) => {
      insideObserver = true;
      try {
        reconcileMarkdownMemoryScope(dbManager, entries, "memory", null);
      } finally {
        insideObserver = false;
      }
      return null;
    });

    try {
      const result = await applyReviewOperations(store, null, [
        { action: "add", target: "memory", content: "observer owns reconciliation" },
      ], dbManager);

      assert.strictEqual(result.appliedCount, 1);
    } finally {
      dbManager.close();
    }
  });
});

describe("provider auth freshness", () => {
  /**
   * Mirrors AuthStorage as of pi 0.99.x: every getApiKeyAndHeaders call
   * revision-checks auth.json and re-reads it when the file changed, so the
   * mock reads `disk` on every call. A rotation tool rewrites `disk`; the
   * next credential read picks the new key up.
   */
  function rotatingRegistry(initialKey: string) {
    const state = { disk: initialKey, reads: 0 };
    const modelRegistry = {
      getApiKeyAndHeaders: async () => {
        state.reads++;
        return { ok: true as const, apiKey: state.disk };
      },
      getAll: () => [mockModel(false)],
      getAvailable: () => [mockModel(false)],
    };
    return { state, modelRegistry };
  }

  function completionStub(behaviour: (apiKey: string | undefined, attempt: number) => unknown) {
    const usedKeys: Array<string | undefined> = [];
    const complete = async (_model: unknown, _request: unknown, options: { apiKey?: string }) => {
      usedKeys.push(options.apiKey);
      const outcome = behaviour(options.apiKey, usedKeys.length);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    return { usedKeys, complete };
  }

  const emptyOperations = {
    stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify({ operations: [] }) }],
  };

  function directOptions() {
    return { userPrompt: "u", systemPrompt: "s", config: {} };
  }

  it("re-reads credentials before each completion so a rotated key is picked up", async () => {
    const { state, modelRegistry } = rotatingRegistry("stale-key");
    state.disk = "rotated-key";
    const { usedKeys, complete } = completionStub(() => emptyOperations);

    const result = await runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry } as never,
      null as never,
      null,
      directOptions(),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(state.reads, 1, "credentials must be resolved fresh per completion, not cached");
    assert.deepStrictEqual(usedKeys, ["rotated-key"], "the rotated key must reach the provider");
  });

  it("retries once with the rotated key when the provider rejects the current one", async () => {
    const { state, modelRegistry } = rotatingRegistry("revoked-key");
    const { usedKeys, complete } = completionStub((_key, attempt) => {
      if (attempt > 1) return emptyOperations;
      // Hitting the weekly limit is what triggers the external rotation.
      state.disk = "rotated-key";
      return new Error("HTTP 401 Unauthorized: invalid api key");
    });

    const result = await runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry } as never,
      null as never,
      null,
      directOptions(),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(usedKeys, ["revoked-key", "rotated-key"]);
  });

  it("does not retry when the refreshed key is the same one the provider rejected", async () => {
    const { modelRegistry } = rotatingRegistry("only-key");
    const { usedKeys, complete } = completionStub(() => new Error("HTTP 401 Unauthorized"));

    const result = await runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry } as never,
      null as never,
      null,
      directOptions(),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.fallbackReason, "provider_error");
    assert.strictEqual(usedKeys.length, 1, "an unchanged key means a real auth problem, not a rotation race");
  });

  it("classifies provider auth rejections without swallowing other failures", () => {
    for (const message of [
      "HTTP 401 Unauthorized",
      "403 Forbidden",
      "invalid_api_key",
      "Invalid API key provided",
      "authentication failed",
      "token expired",
      "subscription key revoked",
    ]) {
      assert.strictEqual(isAuthRejection(message), true, message);
    }

    for (const message of [
      "HTTP 500 Internal Server Error",
      "429 rate limit exceeded",
      "socket hang up",
    ]) {
      assert.strictEqual(isAuthRejection(message), false, message);
    }
  });
});

// Ported from upstream #259/#250 — adapted to the fork's signature
// (sessionId passed via RunDirectMemoryCompletionOptions / explicit param).
describe("opencode session header (#250)", () => {
  function opencodeModel(provider: string, baseUrl?: string): Model<Api> {
    return {
      id: "test-model",
      provider,
      api: "openai-completions",
      reasoning: false,
      ...(baseUrl ? { baseUrl } : {}),
    } as Model<Api>;
  }

  it("scopes by provider id and host, and adds no header for foreign providers", () => {
    const auth = { apiKey: "sk-test", headers: { "X-Test": "1" } };
    const signal = new AbortController().signal;

    // opencode provider → header added, other headers preserved.
    assert.deepStrictEqual(
      buildDirectReviewCompletionOptions(opencodeModel("opencode"), auth, undefined, signal, "sess-1").headers,
      { "X-Test": "1", "x-opencode-session": "sess-1", "x-opencode-client": "pi" },
    );
    // opencode-go provider → header added.
    assert.ok(
      "x-opencode-session" in (buildDirectReviewCompletionOptions(opencodeModel("opencode-go"), auth, undefined, signal, "sess-1").headers ?? {}),
    );
    // Foreign provider on the opencode.ai host → header added.
    assert.ok(
      "x-opencode-session" in (buildDirectReviewCompletionOptions(opencodeModel("other", "https://opencode.ai/v1"), auth, undefined, signal, "sess-1").headers ?? {}),
    );
    // Foreign provider, foreign host → untouched.
    assert.deepStrictEqual(
      buildDirectReviewCompletionOptions(opencodeModel("other", "https://api.example.com/v1"), auth, undefined, signal, "sess-1").headers,
      { "X-Test": "1" },
    );
  });

  it("keeps an operator-configured session header instead of overwriting it", () => {
    const auth = { apiKey: "sk-test", headers: { "X-Opencode-Session": "operator-session" } };
    const options = buildDirectReviewCompletionOptions(
      opencodeModel("opencode"),
      auth,
      undefined,
      new AbortController().signal,
      "hermes-session",
    );
    assert.strictEqual(options.headers?.["X-Opencode-Session"], "operator-session");
    assert.ok(!("x-opencode-client" in (options.headers ?? {})));
  });

  it("adds no header when the session id is empty", () => {
    const auth = { apiKey: "sk-test", headers: { "X-Test": "1" } };
    const options = buildDirectReviewCompletionOptions(
      opencodeModel("opencode"),
      auth,
      undefined,
      new AbortController().signal,
      undefined,
    );
    assert.deepStrictEqual(options.headers, { "X-Test": "1" });
  });

  it("returns the same object reference when no header is added (no copy churn)", () => {
    const headers = { "X-Test": "1" };
    const auth = { apiKey: "sk-test", headers };
    const options = buildDirectReviewCompletionOptions(
      opencodeModel("other", "https://api.example.com"),
      auth,
      undefined,
      new AbortController().signal,
      "sess-1",
    );
    assert.strictEqual(options.headers, headers);
  });
});

describe("fallback model chain (#215/#219)", () => {
  function twoModelRegistry() {
    const m1 = { id: "m1", provider: "p1", api: "openai-completions", reasoning: false } as Model<Api>;
    const m2 = { id: "m2", provider: "p2", api: "openai-completions", reasoning: false } as Model<Api>;
    let authCalls = 0;
    const registry = {
      getApiKeyAndHeaders: async () => {
        authCalls++;
        return { ok: true as const, apiKey: "k" };
      },
      getAll: () => [m1, m2],
      getAvailable: () => [m1, m2],
    };
    return { registry, get authCalls() { return authCalls; } };
  }

  function chainOptions(signal?: AbortSignal) {
    return {
      userPrompt: "u",
      systemPrompt: "s",
      config: { llmModelOverride: "p1/m1", llmFallbackModels: ["p2/m2"] },
      ...(signal ? { signal } : {}),
    };
  }

  const chainEmptyReview = {
    stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify({ operations: [] }) }],
  };

  it("stops the chain when the caller aborts instead of trying the next model", async () => {
    const caller = new AbortController();
    const attempted: string[] = [];
    const complete = async (model: Model<Api>) => {
      attempted.push(model.id);
      caller.abort();
      return { stopReason: "aborted" };
    };
    const chain = twoModelRegistry();

    const result = await runDirectMemoryCompletion(
      { model: undefined, modelRegistry: chain.registry } as never,
      null as never,
      null,
      chainOptions(caller.signal),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.fallbackReason, "aborted");
    assert.deepStrictEqual(attempted, ["m1"]);
    assert.strictEqual(chain.authCalls, 1);
  });

  it("still tries the next model after a per-model timeout while the caller is alive", async () => {
    const caller = new AbortController();
    const attempted: string[] = [];
    const complete = async (model: Model<Api>) => {
      attempted.push(model.id);
      if (attempted.length === 1) return { stopReason: "aborted" };
      return chainEmptyReview;
    };

    const chain = twoModelRegistry();
    const result = await runDirectMemoryCompletion(
      { model: undefined, modelRegistry: chain.registry } as never,
      null as never,
      null,
      chainOptions(caller.signal),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.deepStrictEqual(attempted, ["m1", "m2"]);
    assert.strictEqual(result.ok, true);
  });

  it("advances the chain on parse errors and reports provider_error after exhausting it", async () => {
    const attempted: string[] = [];
    const complete = async (model: Model<Api>) => {
      attempted.push(model.id);
      if (attempted.length === 1) return { stopReason: "stop", content: [{ type: "text", text: "not json" }] };
      throw new Error("p2 down");
    };

    const chain = twoModelRegistry();
    const result = await runDirectMemoryCompletion(
      { model: undefined, modelRegistry: chain.registry } as never,
      null as never,
      null,
      chainOptions(),
      null,
      null,
      { completeSimple: complete as never },
    );

    assert.deepStrictEqual(attempted, ["m1", "m2"]);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.fallbackReason, "provider_error");
    assert.strictEqual(result.error, "p2 down");
  });

  it("resolves the chain in order and falls back to the ctx model when nothing resolves", () => {
    const m1 = { id: "m1", provider: "p1", api: "openai-completions", reasoning: false } as Model<Api>;
    const m2 = { id: "m2", provider: "p2", api: "openai-completions", reasoning: false } as Model<Api>;
    const ctxModel = { id: "ctx", provider: "pc", api: "openai-completions", reasoning: false } as Model<Api>;
    const registry = { getAll: () => [m1, m2], getAvailable: () => [m1, m2] };

    assert.deepStrictEqual(
      resolveReviewModels(undefined, registry as never, { llmModelOverride: "p1/m1", llmFallbackModels: ["p2/m2"] } as never),
      [m1, m2],
    );
    assert.deepStrictEqual(
      resolveReviewModels(ctxModel, { getAll: () => [] } as never, { llmModelOverride: "ghost/x" } as never),
      [ctxModel],
    );
    assert.deepStrictEqual(
      resolveReviewModels(ctxModel, { getAll: () => [] } as never, {} as never),
      [ctxModel],
    );
  });
});


describe("thinking-channel recovery + empty_response (#235/#239)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "thinking-ops-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function freshStore() {
    return new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
  }

  function okRegistry(model: Model<Api>) {
    return {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
      getAll: () => [model],
      getAvailable: () => [model],
    };
  }

  function thinkingOnly(thinkingText: string) {
    return { stopReason: "stop", content: [{ type: "thinking", thinking: thinkingText }] };
  }

  function runCtx(registry: unknown) {
    return { model: mockModel(false), modelRegistry: registry } as never;
  }

  async function run(
    store: unknown,
    config: unknown,
    complete: unknown,
    extraDeps: Record<string, unknown> = {},
  ) {
    return runDirectMemoryCompletion(
      runCtx(okRegistry(mockModel(false))),
      store as never,
      null,
      { userPrompt: "u", systemPrompt: "s", config: config as never } as never,
      null,
      null,
      { completeSimple: complete, ...extraDeps } as never,
    );
  }

  // ── shared-cascade (text channel) extraction ──
  it("prefers the last operations object when CoT restates the schema first (#197)", () => {
    assert.deepStrictEqual(parseReviewOperations(
      'The schema is {"operations":[]} but I will save:\n{"operations":[{"action":"add","target":"user","content":"prefers dark mode"}]}',
    ), [{ action: "add", target: "user", content: "prefers dark mode" }]);
  });

  it("still parses a single object surrounded by prose via the first-to-last slice", () => {
    assert.deepStrictEqual(parseReviewOperations(
      'Sure — here it is:\n{"operations":[{"action":"add","target":"user","content":"prefers dark mode"}]}\nDone.',
    ), [{ action: "add", target: "user", content: "prefers dark mode" }]);
  });

  it("returns null when no candidate object carries an operations array", () => {
    assert.strictEqual(parseReviewOperations('checked {"a":1} and {"b":2} — nothing worth saving'), null);
  });

  it("does not parse live operations out of any direct prompt (schema echo, #197)", () => {
    for (const prompt of [DIRECT_REVIEW_SYSTEM_PROMPT, DIRECT_FLUSH_SYSTEM_PROMPT, DIRECT_CONSOLIDATION_SYSTEM_PROMPT, DIRECT_CORRECTION_SYSTEM_PROMPT]) {
      const parsed = parseReviewOperations(prompt);
      assert.ok(
        parsed === null || parsed.length === 0,
        "direct prompt must not contain a parseable operations example, got " + JSON.stringify(parsed),
      );
    }
  });

  it("parses a trailing answer when a fenced non-ops object comes first (#235)", () => {
    assert.deepStrictEqual(parseReviewOperations(
      '```json\n{"note":"no ops here"}\n```\nFinal:\n{"operations":[{"action":"add","target":"user","content":"real answer"}]}',
    ), [{ action: "add", target: "user", content: "real answer" }]);
  });

  it("recovers the answer when an unbalanced brace in prose precedes it", () => {
    assert.deepStrictEqual(parseReviewOperations(
      'a { broken \n{"operations":[{"action":"add","target":"user","content":"ok"}]}',
    ), [{ action: "add", target: "user", content: "ok" }]);
  });
});

describe("direct thinking-channel recovery (#235/#239)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "thinking-direct-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function freshStore() {
    return new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
  }

  function thinkingOnly(thinkingText: string) {
    return { stopReason: "stop", content: [{ type: "thinking", thinking: thinkingText }] };
  }

  async function run(store: unknown, complete: unknown, extraDeps: Record<string, unknown> = {}) {
    return runDirectMemoryCompletion(
      { model: mockModel(false), modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }), getAll: () => [mockModel(false)], getAvailable: () => [mockModel(false)] } } as never,
      store as never,
      null,
      { userPrompt: "u", systemPrompt: "s", config: {} } as never,
      null,
      null,
      { completeSimple: complete, ...extraDeps } as never,
    );
  }

  it("parses ops from thinking blocks and applies them when the channel is trailing", async () => {
    const store = freshStore();
    const result = await run(store, () => thinkingOnly(
      'reasoning...\n{"operations":[{"action":"add","target":"memory","content":"thinking-sourced save"}]}',
    ));

    assert.deepStrictEqual(result, { ok: true, appliedCount: 1 });
    assert.ok(store.getMemoryEntries().some((entry: string) => entry.includes("thinking-sourced save")));
  });

  it("prefers text blocks over thinking blocks when both are present", async () => {
    const result = await run(freshStore(), () => ({
      stopReason: "stop",
      content: [
        { type: "text", text: "not json at all" },
        { type: "thinking", thinking: '{"operations":[{"action":"add","target":"memory","content":"x"}]}' },
      ],
    }));

    assert.deepStrictEqual(result, { ok: false, appliedCount: 0, fallbackReason: "parse_error" });
  });

  it("returns empty_response on a clean stop with neither text nor thinking", async () => {
    assert.deepStrictEqual(
      await run(freshStore(), () => ({ stopReason: "stop", content: [] })),
      { ok: true, appliedCount: 0, fallbackReason: "empty_response" },
    );
  });

  it("keeps parse_error when a truncated (length) response has no content", async () => {
    assert.deepStrictEqual(
      await run(freshStore(), () => ({ stopReason: "length", content: [] })),
      { ok: false, appliedCount: 0, fallbackReason: "parse_error" },
    );
  });

  it("treats a redacted-only completion as empty_response, not parse_error", async () => {
    assert.deepStrictEqual(
      await run(freshStore(), () => ({
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "hidden", redacted: true }],
      })),
      { ok: true, appliedCount: 0, fallbackReason: "empty_response" },
    );
  });

  it("falls back to thinking when the text block is whitespace only", async () => {
    assert.deepStrictEqual(
      await run(freshStore(), () => ({
        stopReason: "stop",
        content: [
          { type: "text", text: "   \n  " },
          { type: "thinking", thinking: '{"operations":[]}' },
        ],
      })),
      { ok: true, appliedCount: 0, fallbackReason: "empty" },
    );
  });

  it("settles empty_response when thinking output parses to nothing on a clean stop (#235)", async () => {
    assert.deepStrictEqual(
      await run(freshStore(), () => thinkingOnly("I thought about it but decided nothing")),
      { ok: true, appliedCount: 0, fallbackReason: "empty_response" },
    );
  });

  it("keeps parse_error when unparseable thinking output is truncated (#235)", async () => {
    assert.deepStrictEqual(
      await run(freshStore(), () => ({ stopReason: "length", content: [{ type: "thinking", thinking: '{"operations":[{"action":' }] })),
      { ok: false, appliedCount: 0, fallbackReason: "parse_error" },
    );
  });
});

describe("thinking trust boundary + fallback walk (#235/#239)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "thinking-trust-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function freshStore() {
    return new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
  }

  function thinkingOnly(thinkingText: string) {
    return { stopReason: "stop", content: [{ type: "thinking", thinking: thinkingText }] };
  }

  async function run(store: unknown, complete: unknown, extraDeps: Record<string, unknown> = {}, model: Model<Api> = mockModel(false)) {
    return runDirectMemoryCompletion(
      { model, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }), getAll: () => [model], getAvailable: () => [model] } } as never,
      store as never,
      null,
      { userPrompt: "u", systemPrompt: "s", config: {} } as never,
      null,
      null,
      { completeSimple: complete, ...extraDeps } as never,
    );
  }

  it("applies the trailing answer when CoT restates the schema first", async () => {
    const store = freshStore();
    const result = await run(store, () => thinkingOnly(
      'the schema is {"operations":[]}; final: {"operations":[{"action":"add","target":"memory","content":"real save"}]}',
    ));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.appliedCount, 1);
  });

  it("picks the trailing answer over an earlier fenced draft, and the draft's remove is not applied", async () => {
    const store = freshStore();
    await store.add("memory", "existing entry");
    const result = await run(store, () => thinkingOnly(
      '```json\n{"operations":[{"action":"remove","target":"memory","old_text":"existing entry"}]}\n```\n{"operations":[{"action":"add","target":"memory","content":"final save"}]}',
    ));

    assert.strictEqual(result.appliedCount, 1);
    assert.ok(store.getMemoryEntries().some((entry: string) => entry.includes("existing entry")), "draft's remove must not run");
    assert.ok(store.getMemoryEntries().some((entry: string) => entry.includes("final save")));
  });

  it("applies only adds from a non-trailing (draft-grade) candidate", async () => {
    const store = freshStore();
    await store.add("memory", "existing entry");
    const result = await run(store, () => thinkingOnly(
      '{"operations":[{"action":"remove","target":"memory","old_text":"existing entry"}]} and then some trailing prose',
    ));

    assert.strictEqual(result.appliedCount, 0);
    assert.ok(store.getMemoryEntries().some((entry: string) => entry.includes("existing entry")), "draft remove must not run");
  });

  it("settles empty when the trailing candidate is empty, without reaching back to an earlier draft", async () => {
    const store = freshStore();
    const result = await run(store, () => thinkingOnly(
      '{"operations":[{"action":"add","target":"memory","content":"draft op"}]}\n{"operations":[]}',
    ));

    assert.deepStrictEqual(result, { ok: true, appliedCount: 0, fallbackReason: "empty" });
    assert.strictEqual(store.getMemoryEntries().length, 0);
  });

  it("walks to a healthy fallback model after a silent primary and applies its operations", async () => {
    const store = freshStore();
    const attempted: string[] = [];
    const m1 = { id: "m1", provider: "p1", api: "openai-completions", reasoning: false } as Model<Api>;
    const m2 = { id: "m2", provider: "p2", api: "openai-completions", reasoning: false } as Model<Api>;
    const registry = {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
      getAll: () => [m1, m2],
      getAvailable: () => [m1, m2],
    };

    const result = await runDirectMemoryCompletion(
      { model: undefined, modelRegistry: registry } as never,
      store as never,
      null,
      { userPrompt: "u", systemPrompt: "s", config: { llmModelOverride: "p1/m1", llmFallbackModels: ["p2/m2"] } } as never,
      null,
      null,
      {
        completeSimple: (async (model: Model<Api>) => {
          attempted.push(model.id);
          if (model.id === "m1") return { stopReason: "stop", content: [] };
          return { stopReason: "stop", content: [{ type: "text", text: '{"operations":[{"action":"add","target":"memory","content":"fallback save"}]}' }] };
        }) as never,
      } as never,
    );

    assert.deepStrictEqual(attempted, ["m1", "m2"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.appliedCount, 1);
    assert.ok(store.getMemoryEntries().some((entry: string) => entry.includes("fallback save")));
  });

  it("warns once per process when the answer parks in the thinking channel (#239)", async () => {
    const notices: string[] = [];
    const state = { logged: false };

    await run(freshStore(), () => thinkingOnly(
      'thinking about it\n{"operations":[{"action":"add","target":"memory","content":"notify save"}]}',
    ), { onProviderNotice: (message: string) => notices.push(message), providerNoticeState: state });
    assert.strictEqual(notices.length, 1);
    assert.match(notices[0]!, /Provider misconfiguration/);
    assert.match(notices[0]!, /test\/test-model/);

    await run(freshStore(), () => thinkingOnly(
      'thinking about it\n{"operations":[{"action":"add","target":"memory","content":"notify save 2"}]}',
    ), { onProviderNotice: (message: string) => notices.push(message), providerNoticeState: state });
    assert.strictEqual(notices.length, 1);

    await run(freshStore(), () => ({
      stopReason: "stop",
      content: [{ type: "text", text: '{"operations":[{"action":"add","target":"memory","content":"t"}]}' }],
    }), { onProviderNotice: (message: string) => notices.push(message), providerNoticeState: { logged: false } });
    assert.strictEqual(notices.length, 1);
  });
});

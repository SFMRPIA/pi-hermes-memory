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
  runDirectMemoryCompletion,
} from "../../src/handlers/review-memory-ops.js";
import { DatabaseManager } from "../../src/store/db.js";
import { reconcileMarkdownMemoryScope } from "../../src/store/sqlite-memory-store.js";

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

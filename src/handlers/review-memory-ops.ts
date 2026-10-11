/**
 * Parse and apply structured memory operations from direct background review.
 */

import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { completeSimple, type Message, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import type { DatabaseManager } from "../store/db.js";
import type { MemoryCategory, MemoryConfig, MemoryResult, ThinkingLevel } from "../types.js";

export interface ReviewMemoryOperation {
  action: "add" | "replace" | "remove";
  target: "memory" | "user" | "project" | "failure";
  content?: string;
  old_text?: string;
  category?: MemoryCategory;
  failure_reason?: string;
}

export interface ApplyReviewOperationsResult {
  appliedCount: number;
  skippedCount: number;
}

export interface DirectReviewResult {
  ok: boolean;
  appliedCount: number;
  fallbackReason?: "no_model" | "no_auth" | "aborted" | "parse_error" | "provider_error" | "empty" | "empty_response";
  error?: string;
}

export interface RunDirectMemoryCompletionOptions {
  userPrompt: string;
  systemPrompt: string;
  config: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Pi session id for OpenCode-gated direct completions (#250); callers with
   * a sessionManager compute it via readSessionId — absent = no header. */
  sessionId?: string | undefined;
}

/** Shared transport gate: review/flush/consolidation/correction all default to
 * the in-process direct completion path and fall back to a `pi -p` subprocess
 * only on failure, unless the user forces `reviewTransport: "subprocess"`. */
export function usesDirectTransport(config: Pick<MemoryConfig, "reviewTransport">): boolean {
  return (config.reviewTransport ?? "direct") === "direct";
}

/** One shared budget for a single review/flush/correction/consolidation
 * completion, on both the direct transport and the `pi -p` subprocess
 * fallback. Deliberately not configurable (#197): the bug was the double
 * spend, not the number — after the empty-response short-circuit the
 * painful case is one 120s call. Consolidation keeps its separate
 * `consolidationTimeoutMs` because it is user-visible and must actually
 * shrink. */
export const REVIEW_COMPLETION_TIMEOUT_MS = 120_000;

type ReviewLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride" | "llmFallbackModels">;

function findExactModelReferenceMatch(modelReference: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) return undefined;

  const normalizedReference = trimmedReference.toLowerCase();
  const canonicalMatches = availableModels.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;

  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.substring(0, slashIndex).trim();
    const modelId = trimmedReference.substring(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter(
        (model) => model.provider.toLowerCase() === provider.toLowerCase()
          && model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) return providerMatches[0];
    }
  }

  const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function normalizedModelOverride(config: ReviewLlmConfig): string | undefined {
  const trimmed = config.llmModelOverride?.trim();
  return trimmed ? trimmed : undefined;
}

function effectiveThinkingOverride(config: ReviewLlmConfig): ThinkingLevel | undefined {
  return config.llmThinkingOverride ?? (normalizedModelOverride(config) ? "off" : undefined);
}

type ReviewModelRegistry = ExtensionContext["modelRegistry"];

// Session attribution for OpenCode-gated direct completions (#250, upstream
// #259): the direct transport calls completeSimple itself, so it bypasses the
// session plumbing Pi applies to its own completions, and the OpenCode gateway
// rejects such completions with 400 missing_session_id before the model runs.
// Restated from pi-coding-agent's internal provider-attribution (v0.87.1):
// re-check when bumping the pi-ai floor past 0.86.0.
const OPENCODE_SESSION_HEADER = "x-opencode-session";
const OPENCODE_CLIENT_HEADER = "x-opencode-client";
const OPENCODE_HOST = "opencode.ai";

export type ReviewSessionManager = Pick<ExtensionContext, "sessionManager">["sessionManager"];

function matchesHost(baseUrl: string | undefined, expectedHost: string): boolean {
  try {
    return new URL(baseUrl ?? "").hostname === expectedHost;
  } catch {
    return false;
  }
}

/** A missing session id degrades to the pre-#250 behaviour: the attempt still
 * goes out, and the subprocess fallback owns recovery. */
export function readSessionId(sessionManager: ReviewSessionManager): string | undefined {
  try {
    return sessionManager.getSessionId() || undefined;
  } catch {
    return undefined;
  }
}

/** Returns a copy whenever a header is added: the registry hands out a shared
 * object, and the credential-rotation comparison below must not read hermes'
 * own header as a credential change.
 *
 * An operator-configured session header short-circuits both additions, so that
 * request carries no client header. pi keeps its client header in that case.
 * The divergence is deliberate, because honouring the operator's session id
 * completely is the more predictable contract. */
function directRequestHeaders(
  model: Model<Api>,
  headers: ProviderHeaders | undefined,
  sessionId: string | undefined,
): ProviderHeaders | undefined {
  if (!sessionId) return headers;
  const isOpenCode = model.provider === "opencode"
    || model.provider === "opencode-go"
    || matchesHost(model.baseUrl, OPENCODE_HOST);
  if (!isOpenCode) return headers;
  const alreadySet = Object.keys(headers ?? {}).some(
    (key) => key.toLowerCase() === OPENCODE_SESSION_HEADER,
  );
  if (alreadySet) return headers;
  return {
    ...headers,
    [OPENCODE_SESSION_HEADER]: sessionId,
    [OPENCODE_CLIENT_HEADER]: "pi",
  };
}

export function buildDirectReviewCompletionOptions(
  model: Model<Api>,
  auth: {
    apiKey: string;
    headers?: ProviderHeaders;
    env?: Record<string, string>;
  },
  thinking: ThinkingLevel | undefined,
  signal: AbortSignal,
  sessionId?: string | undefined,
): SimpleStreamOptions {
  const options: SimpleStreamOptions = {
    apiKey: auth.apiKey,
    headers: directRequestHeaders(model, auth.headers, sessionId),
    env: auth.env,
    signal,
  };
  if (model.reasoning && thinking && thinking !== "off") {
    options.reasoning = thinking;
  }
  return options;
}

export function resolveReviewModel(
  ctxModel: Model<Api> | undefined,
  modelRegistry: ReviewModelRegistry,
  config: ReviewLlmConfig,
): Model<Api> | undefined {
  const override = normalizedModelOverride(config);
  if (override) {
    const matched = findExactModelReferenceMatch(override, modelRegistry.getAll());
    if (matched) return matched;
  }
  return ctxModel;
}

function collectFallbackOverrides(config: ReviewLlmConfig): string[] {
  const out: string[] = [];
  for (const raw of config.llmFallbackModels ?? []) {
    const t = raw.trim();
    if (t) out.push(t);
  }
  return out;
}

function allModelOverrides(config: ReviewLlmConfig): string[] {
  const primary = normalizedModelOverride(config);
  const fallbacks = collectFallbackOverrides(config);
  const chain = primary ? [primary, ...fallbacks] : fallbacks;
  return [...new Set(chain)];
}

export function resolveReviewModels(
  ctxModel: Model<Api> | undefined,
  modelRegistry: ReviewModelRegistry,
  config: ReviewLlmConfig,
): Model<Api>[] {
  const chain = allModelOverrides(config);
  if (chain.length === 0) return ctxModel ? [ctxModel] : [];
  const all = modelRegistry.getAll();
  const resolved: Model<Api>[] = [];
  for (const ref of chain) {
    const m = findExactModelReferenceMatch(ref, all);
    if (m) resolved.push(m);
  }
  // If none of the chain resolved, fall back to active model so we still try something
  if (resolved.length === 0 && ctxModel) resolved.push(ctxModel);
  return resolved;
}

export function getReviewModelChain(config: ReviewLlmConfig): string[] {
  return allModelOverrides(config);
}

/**
 * Provider responses that mean "this key is no longer good", as opposed to a
 * transport hiccup or a model error worth falling back to a subprocess for.
 */
const AUTH_REJECTION_PATTERN = new RegExp([
  String.raw`\b(401|403)\b`,
  "unauthorized",
  "forbidden",
  String.raw`invalid[\s_-]*api[\s_-]*key`,
  String.raw`authentication[\s_-]*(failed|error)`,
  String.raw`(invalid|expired|revoked)[\s_-]*(access[\s_-]*)?(token|key|credential)`,
  String.raw`(token|key|credential)[\s_-]*(is[\s_-]*|has[\s_-]*been[\s_-]*)?(invalid|expired|revoked)`,
].join("|"), "i");

export function isAuthRejection(message: string): boolean {
  return AUTH_REJECTION_PATTERN.test(message);
}

/**
 * Mirrors the SDK's ResolvedRequestAuth. pi-coding-agent declares it in
 * core/model-registry but does not re-export it from the package root, and its
 * `exports` map blocks deep imports — so name it here. tsc still checks the
 * shape against the real registry at the call below, so drift is a build error.
 */
export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> }
  | { ok: false; error: string };

/**
 * Resolve request auth with credentials as fresh as the host allows.
 *
 * Through pi 0.80.x, AuthStorage parsed auth.json once in its constructor and
 * only reloaded it when an OAuth refresh failed — so an api_key credential was
 * effectively frozen for the process lifetime, and a key rotated on disk by
 * another tool (e.g. @lnilluv/pi-opencode-go-rotation swapping an opencode-go
 * subscription key after a weekly limit) stayed invisible to this session
 * (#139). We worked around that by calling the then-public
 * ModelRegistry.authStorage.reload() before each completion.
 *
 * Since pi 0.99.x, AuthStorage.read() revision-checks auth.json on every read
 * and reloads automatically when the file changed, and ModelRegistry no longer
 * exposes authStorage — so getApiKeyAndHeaders alone now yields rotated keys,
 * and this wrapper only keeps the fresh-read name and call seam.
 */
export async function resolveFreshRequestAuth(
  modelRegistry: ReviewModelRegistry,
  model: Model<Api>,
): Promise<ResolvedRequestAuth> {
  return modelRegistry.getApiKeyAndHeaders(model);
}

/** A JSON object extracted from a model response, validated to carry an
 * `operations` array. Candidate payloads without one are declined at every
 * extraction step, so a log line, counterexample, or stray snippet cannot
 * claim the parse and force the subprocess fallback (#235). */
type JsonObjectPayload = { operations?: unknown };

function isJsonObjectPayload(value: unknown): value is JsonObjectPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Balanced {...} regions at any nesting depth, string- and escape-aware.
 * Recording every matched pair — not just top-level ones — means an
 * unbalanced "{" in surrounding prose cannot hide a later object: the
 * object still forms its own balanced region nested inside the phantom
 * one (#235). */
function balancedObjectSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const open: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      open.push(i);
    } else if (ch === "}") {
      const start = open.pop();
      if (start !== undefined) spans.push([start, i]);
    }
  }
  return spans;
}

/** CoT routinely restates the schema before answering, so the first-to-last
 * slice above is invalid JSON across that span. Scan balanced objects from
 * the end and return the last one that parses with an `operations` array —
 * the answer trailing the preamble (#197). */
function lastParseableOperationsObject(text: string): JsonObjectPayload | null {
  const spans = balancedObjectSpans(text);
  for (let s = spans.length - 1; s >= 0; s--) {
    const span = spans[s];
    if (!span) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(span[0], span[1] + 1));
      if (isJsonObjectPayload(parsed) && Array.isArray(parsed.operations)) {
        return parsed;
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}

function extractJsonPayload(text: string): JsonObjectPayload | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const asObject = (value: unknown): JsonObjectPayload | null =>
    isJsonObjectPayload(value) && Array.isArray(value.operations) ? value : null;

  // A declined candidate (valid JSON, no `operations` array) must fall through
  // to the later paths rather than exit — exiting here is how a stray snippet
  // claimed the parse and forced the subprocess while a valid trailing
  // answer was present (#235).
  try {
    const parsed = asObject(JSON.parse(trimmed));
    if (parsed) return parsed;
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      const parsed = asObject(JSON.parse(fenced[1].trim()));
      if (parsed) return parsed;
    } catch {
      // continue
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = asObject(JSON.parse(trimmed.slice(start, end + 1)));
      if (parsed) return parsed;
    } catch {
      return lastParseableOperationsObject(trimmed);
    }
  }

  return lastParseableOperationsObject(trimmed);
}

/** A winning thinking-channel candidate plus whether it sits at the tail of
 * the channel — the trust boundary for thinking-sourced operations. */
interface ThinkingOperationsCandidate {
  payload: JsonObjectPayload;
  trailing: boolean;
}

/** Thinking-sourced text takes its own extraction (#235): candidates are
 * validated on their `operations` array and scanned from the end, because a
 * chain of thought routinely restates the schema — or drafts an operation it
 * then rejects — before the final answer. The shared cascade would let an
 * earlier fenced draft win before this scan runs. The winner is the last
 * ops-bearing object; `trailing` reports whether anything follows it, which
 * decides how much to trust it. */
function extractThinkingOperations(text: string): ThinkingOperationsCandidate | null {
  const spans = balancedObjectSpans(text);
  for (let s = spans.length - 1; s >= 0; s--) {
    const span = spans[s];
    if (!span) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(span[0], span[1] + 1));
      if (isJsonObjectPayload(parsed) && Array.isArray(parsed.operations)) {
        return { payload: parsed, trailing: text.slice(span[1] + 1).trim() === "" };
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}

function isMemoryCategory(value: unknown): value is MemoryCategory {
  return value === "failure"
    || value === "correction"
    || value === "insight"
    || value === "preference"
    || value === "convention"
    || value === "tool-quirk";
}

function isReviewTarget(value: unknown): value is ReviewMemoryOperation["target"] {
  return value === "memory" || value === "user" || value === "project" || value === "failure";
}

function isReviewAction(value: unknown): value is ReviewMemoryOperation["action"] {
  return value === "add" || value === "replace" || value === "remove";
}

export function parseReviewOperations(text: string): ReviewMemoryOperation[] | null {
  if (/nothing to save/i.test(text) && !text.includes("{")) {
    return [];
  }

  const payload = extractJsonPayload(text);
  if (!payload) {
    return null;
  }

  return mapOperationsArray(payload.operations);
}

/** Map a candidate `operations` array to validated review operations; null
 * means the payload is not an operations payload at all. */
function mapOperationsArray(operations: unknown): ReviewMemoryOperation[] | null {
  if (!Array.isArray(operations)) return null;

  const parsed: ReviewMemoryOperation[] = [];
  for (const item of operations) {
    if (!item || typeof item !== "object") continue;
    const op = item as Record<string, unknown>;
    if (!isReviewAction(op.action) || !isReviewTarget(op.target)) continue;

    const operation: ReviewMemoryOperation = {
      action: op.action,
      target: op.target,
    };
    if (typeof op.content === "string") operation.content = op.content;
    if (typeof op.old_text === "string") operation.old_text = op.old_text;
    if (isMemoryCategory(op.category)) operation.category = op.category;
    if (typeof op.failure_reason === "string") operation.failure_reason = op.failure_reason;
    parsed.push(operation);
  }

  return parsed;
}

export async function applyReviewOperations(
  store: MemoryStore,
  projectStore: MemoryStore | null,
  operations: ReviewMemoryOperation[],
  _dbManager: DatabaseManager | null = null,
  _projectName?: string | null,
): Promise<ApplyReviewOperationsResult> {
  let appliedCount = 0;
  let skippedCount = 0;

  for (const op of operations) {
    if (op.target === "project" && !projectStore) {
      skippedCount++;
      continue;
    }

    const rawTarget = op.target;
    const memoryTarget = rawTarget === "project" ? "memory" : rawTarget === "failure" ? "failure" : rawTarget;
    const activeStore = rawTarget === "project" ? projectStore! : store;

    let result: MemoryResult;
    switch (op.action) {
      case "add": {
        if (!op.content?.trim()) {
          skippedCount++;
          continue;
        }
        if (rawTarget === "failure") {
          const category = op.category ?? "failure";
          result = await activeStore.addFailure(op.content, {
            category,
            failureReason: op.failure_reason,
          });
          if (result.success) {
            appliedCount++;
          } else {
            skippedCount++;
          }
        } else {
          result = await activeStore.add(memoryTarget, op.content);
          if (result.success) {
            appliedCount++;
          } else {
            skippedCount++;
          }
        }
        break;
      }
      case "replace": {
        if (!op.old_text || !op.content?.trim()) {
          skippedCount++;
          continue;
        }
        result = await activeStore.replace(memoryTarget, op.old_text, op.content);
        if (result.success) {
          appliedCount++;
        } else {
          skippedCount++;
        }
        break;
      }
      case "remove": {
        if (!op.old_text) {
          skippedCount++;
          continue;
        }
        result = await activeStore.remove(memoryTarget, op.old_text);
        if (result.success) {
          appliedCount++;
        } else {
          skippedCount++;
        }
        break;
      }
      default:
        skippedCount++;
        continue;
    }

  }

  return { appliedCount, skippedCount };
}

/** Channel-aware text extraction: text blocks when present, otherwise the
 * thinking channel — thinking-default servers park the whole answer in the
 * reasoning channel (e.g. vLLM with DEFAULT_THINKING=max, regardless of the
 * client-side level), so it is recovered there rather than treated as a
 * parse error (#197). The source decides which extraction path parses it:
 * the text channel keeps the shared cascade, thinking takes its own
 * end-scan (#235). */
function responseChannelText(content: unknown): { text: string; source: "text" | "thinking" } {
  if (!Array.isArray(content)) return { text: "", source: "text" };
  const text = content
    .filter((block): block is { type: "text"; text: string } => (
      !!block && typeof block === "object" && (block as { type?: string }).type === "text"
    ))
    .map((block) => block.text)
    .join("\n");
  if (text.trim()) return { text, source: "text" };

  // Anthropic redacted_thinking arrives as {type:"thinking", redacted:true}
  // after normalization — there is no recoverable payload in it, and letting
  // it through would turn a redacted-only completion into a parse_error and
  // burn the subprocess fallback (#197).
  const thinking = content
    .filter((block): block is { type: "thinking"; thinking: string } => (
      !!block && typeof block === "object" && (block as { type?: string }).type === "thinking"
      && (block as { redacted?: boolean }).redacted !== true
    ))
    .map((block) => block.thinking)
    .join("\n");
  return { text: thinking, source: "thinking" };
}

const defaultProviderNoticeState = { logged: false };

/** Fired once per process when a provider returns the whole answer in its
 * thinking channel with an empty answer channel. That signature means the
 * provider's server-side thinking default is swallowing the output (the #197
 * report), so thinking-channel recovery is a workaround for a
 * misconfiguration, not a feature to rely on. */
function notifyThinkingChannelProvider(
  model: { provider?: unknown; id?: unknown },
  deps: { onProviderNotice?: (message: string) => void; providerNoticeState?: { logged: boolean } },
): void {
  const state = deps.providerNoticeState ?? defaultProviderNoticeState;
  if (state.logged) return;
  state.logged = true;
  const modelRef = typeof model?.provider === "string" && typeof model?.id === "string"
    ? `${model.provider}/${model.id}`
    : "the active model";
  const sink = deps.onProviderNotice ?? ((message: string) => console.warn(message));
  sink(
    `[pi-hermes-memory] Provider misconfiguration: ${modelRef} returned the whole answer in its thinking channel and left the answer channel empty. `
      + "This usually means server-side thinking is forced on for this provider (for example a vLLM server started with DEFAULT_THINKING=max). "
      + "Review recovery from the thinking channel is best-effort and can miss saves. "
      + "Ask your Pi to fix this as well.",
  );
}

export async function runDirectMemoryCompletion(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  options: RunDirectMemoryCompletionOptions,
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
  deps: {
    completeSimple?: typeof completeSimple;
    /** Test seam: replaces the console.warn sink for the provider notice. */
    onProviderNotice?: (message: string) => void;
    /** Test seam: dedupe state for the provider notice; omit for the process default. */
    providerNoticeState?: { logged: boolean };
  } = {},
): Promise<DirectReviewResult> {
  const complete = deps.completeSimple ?? completeSimple;
  const aborted = (): DirectReviewResult => ({ ok: false, appliedCount: 0, fallbackReason: "aborted" });
  if (options.signal?.aborted) return aborted();

  const models = resolveReviewModels(ctx.model, ctx.modelRegistry, options.config);
  if (models.length === 0) {
    return { ok: false, appliedCount: 0, fallbackReason: "no_model" };
  }

  // Try each model in chain: primary + llmFallbackModels. Only retry on
  // provider/auth/transport failures; parse errors are prompt-specific so we
  // still try the next model as it may have better instruction following.
  let lastResult: DirectReviewResult | undefined;
  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi]!;
    // A caller abort (user cancel, shutdown bound) ends the whole chain: the
    // next iteration's listener would never fire for an already-aborted
    // signal, so continuing would burn a full timeout per remaining model.
    if (options.signal?.aborted) return aborted();
    const auth = await resolveFreshRequestAuth(ctx.modelRegistry, model);
    if (options.signal?.aborted) return aborted();
    if (!auth.ok || !auth.apiKey) {
      lastResult = {
        ok: false,
        appliedCount: 0,
        fallbackReason: "no_auth",
        error: auth.ok ? `No API key for ${model.provider}` : auth.error,
      };
      if (mi < models.length - 1) continue;
      return lastResult;
    }
    let requestAuth = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env };

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? REVIEW_COMPLETION_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
      if (options.signal.aborted) controller.abort();
    }

    const thinking = effectiveThinkingOverride(options.config);
    const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text: options.userPrompt }],
      timestamp: Date.now(),
    };

    const request = { systemPrompt: options.systemPrompt, messages: [userMessage] };

    try {
      let response;
      try {
        response = await complete(
          model,
          request,
          buildDirectReviewCompletionOptions(model, requestAuth, thinking, controller.signal, options.sessionId),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (controller.signal.aborted || !isAuthRejection(message)) throw err;

        // The provider rejected the key mid-flight. A rotation tool may have
        // written a new one since we resolved auth; re-read and retry once, but
        // only if the key actually changed — otherwise this is a real auth
        // problem and the subprocess fallback should handle it (#139).
        const rotated = await resolveFreshRequestAuth(ctx.modelRegistry, model);
        if (!rotated.ok || !rotated.apiKey || rotated.apiKey === requestAuth.apiKey) throw err;

        requestAuth = { apiKey: rotated.apiKey, headers: rotated.headers, env: rotated.env };
        response = await complete(
          model,
          request,
          buildDirectReviewCompletionOptions(model, requestAuth, thinking, controller.signal, options.sessionId),
        );
      }

      if (options.signal?.aborted) {
        clearTimeout(timeout);
        return aborted();
      }
      if (response.stopReason === "aborted" || controller.signal.aborted) {
        lastResult = { ok: false, appliedCount: 0, fallbackReason: "aborted" };
        if (mi < models.length - 1) { clearTimeout(timeout); continue; }
        return lastResult;
      }

      const { text, source } = responseChannelText(response.content);
      // The thinking-only signature means the provider's server-side thinking
      // default is swallowing the answer channel (#197). Recovery works, but
      // it is best-effort; surface the misconfiguration once per process so
      // the user can fix the provider instead of relying on the recovery.
      if (source === "thinking" && text.trim() !== "") {
        notifyThinkingChannelProvider(model, deps);
      }

      // Thinking-sourced text takes its own extraction (#235): candidates are
      // validated on their `operations` array and scanned from the end, and
      // the winner's trailing-ness sets how much to trust it. The text channel
      // keeps the shared cascade untouched so today's parse successes do not
      // move.
      let operations: ReviewMemoryOperation[] | null;
      let unparsableThinking = false;
      if (source === "thinking") {
        const extraction = extractThinkingOperations(text);
        if (extraction) {
          operations = mapOperationsArray(extraction.payload.operations) ?? [];
          // A candidate that is not trailing is draft-grade: apply only its
          // adds. Trusting a draft's replace/remove — or reaching back to an
          // earlier candidate when the trailing one is empty — would execute
          // operations the model may have rejected; a missed save is
          // recoverable, a wrong deletion is not.
          if (!extraction.trailing) {
            operations = operations.filter((operation) => operation.action === "add");
          }
        } else {
          operations = null;
          unparsableThinking = true;
        }
      } else {
        operations = parseReviewOperations(text);
      }

      // A clean stop with no usable output — nothing in either channel, or
      // thinking-sourced output that parses to nothing — settles
      // empty_response: the subprocess would run the same model against the
      // same server-side thinking default and fail the same way (#197). The
      // chain still walks llmFallbackModels first, like parse_error does: a
      // silent primary model should not end the review while a configured
      // fallback may answer (#235). Never the subprocess on this path.
      // Truncated responses (stopReason "length") still fall through to
      // parse_error so the chain can retry them.
      if ((!text.trim() || unparsableThinking) && response.stopReason === "stop") {
        lastResult = { ok: true, appliedCount: 0, fallbackReason: "empty_response" };
        if (mi < models.length - 1) { clearTimeout(timeout); continue; }
        return lastResult;
      }
      if (operations === null) {
        lastResult = { ok: false, appliedCount: 0, fallbackReason: "parse_error" };
        if (mi < models.length - 1) { clearTimeout(timeout); continue; }
        return lastResult;
      }
      if (operations.length === 0) {
        clearTimeout(timeout);
        return { ok: true, appliedCount: 0, fallbackReason: "empty" };
      }
      if (options.signal?.aborted) {
        clearTimeout(timeout);
        return aborted();
      }
      if (controller.signal.aborted) {
        return aborted();
      }

      const { appliedCount } = await applyReviewOperations(
        store,
        projectStore,
        operations,
        dbManager,
        projectName,
      );
      if (controller.signal.aborted || options.signal?.aborted) {
        return aborted();
      }
      return { ok: true, appliedCount };
    } catch (err) {
      if (controller.signal.aborted || options.signal?.aborted) {
        lastResult = { ok: false, appliedCount: 0, fallbackReason: "aborted" };
      } else {
        lastResult = {
          ok: false,
          appliedCount: 0,
          fallbackReason: "provider_error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (mi < models.length - 1) { clearTimeout(timeout); continue; }
      return lastResult;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
  return lastResult ?? { ok: false, appliedCount: 0, fallbackReason: "provider_error", error: "All fallback models failed" };
}

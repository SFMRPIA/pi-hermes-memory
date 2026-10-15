// Conservative redundant-entry planner. Similarity only finds candidates;
// it never grants deletion permission. Decisions keep existing text verbatim,
// remove only entries covered by the keeper, and never cross store/project scope.
// This module is read-only; applying its hash-checked plan is a separate step.
import { createHash } from "node:crypto";
import type { StoreInventoryEntry } from "../store/memory-store.js";

export type StoreLabel = "memory" | "user" | "failure" | "project";

export interface PlanningEntry extends StoreInventoryEntry {
  store: StoreLabel;
}

export interface CandidateGroup {
  id: string;
  members: PlanningEntry[];
  similarity: number;
}

export type GroupDecision =
  | { action: "deduplicate"; keepIndex: number; removeIndices: number[]; rationale?: string }
  | { action: "keep_both"; rationale?: string };

export interface GroupPlanOutcome {
  kind: "no-action" | "safety-rejected" | "deferred";
  reasonCode: string;
}

export type GroupAnalyzer = ((group: CandidateGroup) => Promise<GroupDecision | null>) & {
  /** True only when this exact content/scope group has a planner-validated cached result. */
  isCached?: (group: CandidateGroup) => Promise<boolean>;
  /** Persist a decision only after deterministic planner validation accepts it. */
  recordValidatedDecision?: (group: CandidateGroup, decision: GroupDecision) => Promise<void>;
  /** Persist a compact, non-reusable outcome for reporting. */
  recordPlanOutcome?: (group: CandidateGroup, outcome: GroupPlanOutcome) => Promise<void>;
};

export interface PlanAction {
  id: string;
  type: "deduplicate";
  store: StoreLabel;
  keep: { index: number; hash: string };
  remove: Array<{ index: number; hash: string }>;
  rationale: string;
}

export interface ReviewItem {
  store: StoreLabel;
  entries: Array<{ index: number; hash: string; text: string }>;
  reason: string;
}

export interface StoreFingerprints {
  memory?: string;
  user?: string;
  failure?: string;
  project?: string;
}

export interface CleanupPlan {
  generatedAt: string;
  fingerprints: StoreFingerprints;
  actions: PlanAction[];
  needsReview: ReviewItem[];
  stats: {
    entriesScanned: number;
    exactDuplicateGroups: number;
    candidateGroups: number;
    analyzedGroups: number;
    freshGroupsAnalyzed: number;
    cachedGroups: number;
    actionsValidated: number;
    rejectedToReview: number;
    keepBothGroups: number;
    safetyRejectedGroups: number;
    analyzerFailedGroups: number;
    deferredGroups: number;
  };
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then",
  "has", "have", "been", "was", "were", "are", "will", "should", "could",
  "their", "them", "they", "than", "then", "here", "there", "what", "which",
  "also", "only", "just", "very", "more", "most", "some", "such", "over",
  "under", "after", "before", "while", "about", "above", "below", "between",
  "because", "being", "both", "each", "other", "same", "onto", "upon", "via",
]);

const QUALIFIER_WORDS = new Set([
  "no", "not", "never", "only", "unless", "except", "without", "may", "might",
  "can", "could", "should", "must", "always", "sometimes", "usually", "rarely",
  "if", "when", "until", "while", "before", "after", "during", "per", "at", "most", "least", "once", "twice",
  "production", "staging", "testing", "test", "development", "dev", "local", "universal",
]);
export const CLEANUP_POLICY_VERSION = "memory-dedup-v3";
const SIMILARITY_THRESHOLD = 0.55;
const MIN_NORMALIZED_LENGTH = 40;
const MAX_GROUP_SIZE = 4;
export const DEFAULT_MAX_GROUPS = 25;

const BOOKKEEPING_COMMENT = /<!--\s*(?:(?:created|last)\s*=\s*\d{4}-\d{2}-\d{2})(?:\s*,\s*(?:created|last)\s*=\s*\d{4}-\d{2}-\d{2})*\s*-->/gi;

/** Remove only recognized created/last date comments for comparison; never mutate stored text. */
export function cleanupComparisonText(text: string): string {
  return text.replace(BOOKKEEPING_COMMENT, " ").replace(/\s+/g, " ").trim();
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function significantTokens(text: string): Set<string> {
  return new Set(
    normalizeText(cleanupComparisonText(text))
      .split(" ")
      .filter((t) => t.length > 3 && !STOPWORDS.has(t)),
  );
}

/** Hard facts = numbers, dates, versions. Losing one is always a regression. */
export function hardFacts(text: string): Set<string> {
  return new Set(normalizeText(cleanupComparisonText(text)).match(/\d+(?:\.\d+)*/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function scopeKey(entry: PlanningEntry): string {
  return `${entry.store}::${entry.project ?? ""}`;
}

function entryRef(entry: PlanningEntry): { index: number; hash: string } {
  return { index: entry.index, hash: entry.hash };
}

function entryId(entry: PlanningEntry): string {
  return `${entry.store}#${entry.index}`;
}

function planId(entries: PlanningEntry[]): string {
  const identity = entries
    .map((entry) => JSON.stringify([entry.store, entry.project ?? null, cleanupComparisonText(entry.text)]))
    .sort()
    .join("|");
  return createHash("sha256")
    .update(`${CLEANUP_POLICY_VERSION}|${identity}`)
    .digest("hex")
    .slice(0, 12);
}

export interface PlanCleanupOptions {
  analyze?: GroupAnalyzer | null;
  maxGroups?: number;
  now?: string;
  onProgress?: (completed: number, total: number) => void;
}

export interface InventoryInput {
  store: StoreLabel;
  entries: StoreInventoryEntry[];
  fingerprint: string;
}

/**
 * Build a cleanup plan from read-only inventories. Deterministic given the
 * same analyzer behavior. Never mutates anything and never calls the analyzer
 * for exact duplicates (deterministic merges need no semantic analysis).
 */
export async function planCleanup(
  inventories: InventoryInput[],
  opts: PlanCleanupOptions = {},
): Promise<CleanupPlan> {
  const analyze = opts.analyze ?? null;
  const maxGroups = Math.max(0, Math.floor(opts.maxGroups ?? DEFAULT_MAX_GROUPS));

  const all: PlanningEntry[] = [];
  const fingerprints: StoreFingerprints = {};
  for (const inv of inventories) {
    fingerprints[inv.store] = inv.fingerprint;
    for (const entry of inv.entries) all.push({ ...entry, store: inv.store });
  }

  const actions: PlanAction[] = [];
  const needsReview: ReviewItem[] = [];
  let exactDuplicateGroups = 0;
  let candidateGroups = 0;
  let analyzedGroups = 0;
  let actionsValidated = 0;
  let rejectedToReview = 0;
  let keepBothGroups = 0;
  let safetyRejectedGroups = 0;
  let analyzerFailedGroups = 0;
  let deferredGroups = 0;

  const consumed = new Set<string>(); // entryIds already covered by an action

  // ---- Phase A: exact fact text + scope equality (timestamps are bookkeeping) ----
  const exactGroups = new Map<string, PlanningEntry[]>();
  for (const entry of all) {
    const factText = cleanupComparisonText(entry.text);
    if (factText === "") continue;
    const key = JSON.stringify([scopeKey(entry), factText]);
    const list = exactGroups.get(key);
    if (list) list.push(entry);
    else exactGroups.set(key, [entry]);
  }
  for (const group of exactGroups.values()) {
    if (group.length < 2) continue;
    exactDuplicateGroups++;
    // Keep the most recently referenced member (tie: lowest index); its raw bytes remain unchanged.
    const sorted = [...group].sort((a, b) =>
      b.lastReferenced.localeCompare(a.lastReferenced) || a.index - b.index,
    );
    const keep = sorted[0];
    const remove = sorted.slice(1);
    for (const e of remove) consumed.add(entryId(e));
    actions.push({
      id: planId(group),
      type: "deduplicate",
      store: keep.store,
      keep: entryRef(keep),
      remove: remove.map(entryRef),
      rationale: "Exact fact duplicate in the same scope (created/last bookkeeping comments ignored); keeper unchanged.",
    });
  }

  // ---- Phase B: near-duplicate candidates for bounded semantic analysis ----
  const candidates: Array<{ a: PlanningEntry; b: PlanningEntry; sim: number }> = [];
  const tokensById = new Map<string, Set<string>>();
  for (const entry of all) {
    tokensById.set(entryId(entry), significantTokens(entry.text));
  }
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    if (consumed.has(entryId(a))) continue;
    for (let j = i + 1; j < all.length; j++) {
      const b = all[j];
      if (consumed.has(entryId(b))) continue;
      if (scopeKey(a) !== scopeKey(b)) continue; // never cross store/scope
      const sim = jaccard(tokensById.get(entryId(a))!, tokensById.get(entryId(b))!);
      if (sim < SIMILARITY_THRESHOLD) continue;
      if (
        normalizeText(cleanupComparisonText(a.text)).length < MIN_NORMALIZED_LENGTH ||
        normalizeText(cleanupComparisonText(b.text)).length < MIN_NORMALIZED_LENGTH
      ) {
        continue; // tiny entries: token overlap is too weak a signal
      }
      candidates.push({ a, b, sim });
    }
  }
  candidates.sort((x, y) => y.sim - x.sim);

  // Greedy union-find into groups (cap size), then cap the number of groups.
  const memberOf = new Map<string, PlanningEntry[]>();
  const find = (id: string) => memberOf.get(id);
  for (const cand of candidates) {
    const ga = find(entryId(cand.a));
    const gb = find(entryId(cand.b));
    if (!ga && !gb) {
      const group = [cand.a, cand.b];
      for (const e of group) memberOf.set(entryId(e), group);
    } else if (ga && !gb) {
      if (ga.length < MAX_GROUP_SIZE && !ga.includes(cand.b)) {
        ga.push(cand.b);
        memberOf.set(entryId(cand.b), ga);
      }
    } else if (!ga && gb) {
      if (gb.length < MAX_GROUP_SIZE && !gb.includes(cand.a)) {
        gb.push(cand.a);
        memberOf.set(entryId(cand.a), gb);
      }
    }
  }
  const seen = new Set<PlanningEntry[]>();
  const groups: CandidateGroup[] = [];
  for (const group of memberOf.values()) {
    if (seen.has(group) || group.length < 2) continue;
    seen.add(group);
    const sim = Math.max(
      ...group.map((m) => {
        let best = 0;
        for (const other of group) {
          if (other === m) continue;
          best = Math.max(best, jaccard(tokensById.get(entryId(m))!, tokensById.get(entryId(other))!));
        }
        return best;
      }),
    );
    // Stable member order keeps cached keep/remove indices attached to the same text.
    const members = [...group].sort((a, b) => cleanupComparisonText(a.text).localeCompare(cleanupComparisonText(b.text)));
    groups.push({ id: planId(members), members, similarity: sim });
  }
  groups.sort((x, y) => y.similarity - x.similarity);
  candidateGroups = groups.length;

  if (!analyze) {
    // No analyzer available: near-duplicates are never mutated. Report every
    // candidate group for review instead.
    for (const group of groups) {
      needsReview.push({
        store: group.members[0].store,
        entries: group.members.map((m) => ({ index: m.index, hash: m.hash, text: m.text })),
        reason: "Similar entries detected but no analyzer is configured; semantic equivalence unproven.",
      });
    }
    return {
      generatedAt: opts.now ?? new Date().toISOString(),
      fingerprints,
      actions,
      needsReview,
      stats: {
        entriesScanned: all.length,
        exactDuplicateGroups,
        candidateGroups,
        analyzedGroups: 0,
        freshGroupsAnalyzed: 0,
        cachedGroups: 0,
        actionsValidated,
        rejectedToReview,
        keepBothGroups,
        safetyRejectedGroups,
        analyzerFailedGroups,
        deferredGroups: groups.length,
      },
    };
  }

  // Successful cached decisions do not consume this run's fresh-analysis budget.
  // This also lets later uncached groups progress past cached keep-both groups.
  const bounded: CandidateGroup[] = [];
  const cachedById = new Map<string, boolean>();
  let freshBudgetUsed = 0;
  for (const group of groups) {
    let cached = false;
    try {
      cached = await analyze.isCached?.(group) ?? false;
    } catch {
      cached = false;
    }
    cachedById.set(group.id, cached);
    if (cached || freshBudgetUsed < maxGroups) {
      bounded.push(group);
      if (!cached) freshBudgetUsed++;
    }
  }

  let freshGroupsAnalyzed = 0;
  let cachedGroups = 0;
  const reportProgress = (completed: number, total: number) => {
    try {
      opts.onProgress?.(completed, total);
    } catch {
      // Progress is best-effort and must not affect planning.
    }
  };
  const recordOutcome = async (group: CandidateGroup, outcome: GroupPlanOutcome) => {
    try { await analyze.recordPlanOutcome?.(group, outcome); } catch { /* best-effort report */ }
  };
  if (bounded.length > 0) reportProgress(0, bounded.length);

  for (const [index, group] of bounded.entries()) {
    const cached = cachedById.get(group.id) ?? false;
    if (cached) cachedGroups++;
    else freshGroupsAnalyzed++;
    let decision: GroupDecision | null = null;
    try {
      decision = await analyze(group);
    } catch {
      decision = null;
    }
    if (decision) analyzedGroups++;
    reportProgress(index + 1, bounded.length);
    const review = (reason: string) => {
      rejectedToReview++;
      needsReview.push({
        store: group.members[0].store,
        entries: group.members.map((m) => ({ index: m.index, hash: m.hash, text: m.text })),
        reason,
      });
    };
    if (!decision) {
      analyzerFailedGroups++;
      await recordOutcome(group, { kind: "no-action", reasonCode: "no-usable-decision" });
      review("Analyzer returned no usable decision for this group.");
      continue;
    }
    if (decision.action === "keep_both") {
      keepBothGroups++;
      try { await analyze.recordValidatedDecision?.(group, decision); } catch { /* best-effort cache */ }
      continue;
    }
    if (decision.action !== "deduplicate") {
      safetyRejectedGroups++;
      await recordOutcome(group, { kind: "safety-rejected", reasonCode: "invalid-action" });
      review(`Unknown action "${String((decision as { action?: unknown }).action)}".`);
      continue;
    }
    const keepIdx = decision.keepIndex;
    const removeIndices = decision.removeIndices;
    if (!Number.isInteger(keepIdx) || keepIdx < 0 || keepIdx >= group.members.length) {
      safetyRejectedGroups++;
      await recordOutcome(group, { kind: "safety-rejected", reasonCode: "invalid-keeper" });
      review("Deduplication decision did not identify a surviving member as keeper.");
      continue;
    }
    if (!Array.isArray(removeIndices) || removeIndices.length === 0
      || removeIndices.some((i) => !Number.isInteger(i) || i < 0 || i >= group.members.length || i === keepIdx)
      || new Set(removeIndices).size !== removeIndices.length) {
      safetyRejectedGroups++;
      await recordOutcome(group, { kind: "safety-rejected", reasonCode: "invalid-selection" });
      review("Deduplication decision has invalid or overlapping member indices.");
      continue;
    }
    const keeper = group.members[keepIdx];
    const victims = removeIndices.map((i) => group.members[i]);
    const result = validateDeduplicate(keeper, victims);
    if (!result.ok) {
      safetyRejectedGroups++;
      await recordOutcome(group, { kind: "safety-rejected", reasonCode: result.reasonCode });
      review(result.reason);
      continue;
    }
    actionsValidated++;
    try { await analyze.recordValidatedDecision?.(group, decision); } catch { /* best-effort cache */ }
    actions.push({
      id: planId([keeper, ...victims]),
      type: "deduplicate",
      store: keeper.store,
      keep: entryRef(keeper),
      remove: victims.map(entryRef),
      rationale: decision.rationale ?? "Existing entry fully covers the selected redundant entries.",
    });
  }

  // Uncached groups beyond the fresh-analysis budget wait for a later run.
  const boundedIds = new Set(bounded.map((group) => group.id));
  for (const group of groups) {
    if (boundedIds.has(group.id)) continue;
    deferredGroups++;
    await recordOutcome(group, { kind: "deferred", reasonCode: "analysis-budget" });
    needsReview.push({
      store: group.members[0].store,
      entries: group.members.map((m) => ({ index: m.index, hash: m.hash, text: m.text })),
      reason: `Analysis budget reached (${maxGroups} uncached groups); left for a later run.`,
    });
  }

  return {
    generatedAt: opts.now ?? new Date().toISOString(),
    fingerprints,
    actions,
    needsReview,
    stats: {
      entriesScanned: all.length,
      exactDuplicateGroups,
      candidateGroups,
      analyzedGroups,
      freshGroupsAnalyzed,
      cachedGroups,
      actionsValidated,
      rejectedToReview,
      keepBothGroups,
      safetyRejectedGroups,
      analyzerFailedGroups,
      deferredGroups,
    },
  };
}

type ValidationResult = { ok: true } | { ok: false; reason: string; reasonCode: string };

function qualifierTokens(text: string): Set<string> {
  const normalized = normalizeText(cleanupComparisonText(text)).replace(/\b(each|every)\b/g, "universal");
  const tokens = new Set(normalized.split(" ").filter((word) => QUALIFIER_WORDS.has(word)));
  for (const match of normalized.matchAll(/\b(project|scenario|environment|workspace|tenant)\s+([a-z0-9_-]+)\b/g)) {
    tokens.add(`${match[1]}:${match[2]}`);
  }
  return tokens;
}

/** A removal is allowed only within scope and when high-risk facts match. */
function validateDeduplicate(keeper: PlanningEntry, victims: PlanningEntry[]): ValidationResult {
  const keeperFacts = hardFacts(keeper.text);
  const keeperQualifiers = qualifierTokens(keeper.text);
  for (const victim of victims) {
    if (victim.store !== keeper.store || (victim.project ?? null) !== (keeper.project ?? null)) {
      return { ok: false, reason: "Entries have different store/project scopes.", reasonCode: "scope-mismatch" };
    }
    for (const fact of hardFacts(victim.text)) {
      if (!keeperFacts.has(fact)) {
        return { ok: false, reason: `Keeper omits hard fact "${fact}" from "${truncate(victim.text)}".`, reasonCode: "hard-fact-missing" };
      }
    }
    const victimQualifiers = qualifierTokens(victim.text);
    if (victimQualifiers.size !== keeperQualifiers.size
      || [...victimQualifiers].some((word) => !keeperQualifiers.has(word))) {
      return { ok: false, reason: `Keeper and removed entry qualifiers differ (conditions/negation) ("${truncate(victim.text)}").`, reasonCode: "qualifier-mismatch" };
    }
  }
  return { ok: true };
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

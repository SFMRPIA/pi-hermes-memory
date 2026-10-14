// Knowledge-preserving cleanup planner (Task 4 of the memory-cleanup plan).
//
// Separates CANDIDATE DISCOVERY from PERMISSION TO DELETE:
//   - Exact duplicates (decoded text + scope equality) → deterministic merge
//     actions, no LLM needed.
//   - Token-similar entries (same store + same scope only) → bounded candidate
//     groups handed to an injected analyzer (LLM). Similarity NEVER proves
//     equivalence — every analyzer decision is re-validated deterministically
//     before it becomes an action.
//   - Anything ambiguous → needs-review (reported, never mutated).
//
// Validation rules (deliberately conservative):
//   - merge: the replacement must retain every hard fact (numbers/dates/
//     versions) of each member, ≥80% of each member's significant tokens, and
//     must not introduce meaningful facts the members don't support.
//   - supersede: requires an explicit correction cue in the survivor text
//     ("no longer", "instead", "fixed", ...), recency (survivor at least as
//     recent as every victim), and no victim hard fact missing from the
//     survivor. A newer timestamp alone is NOT correction evidence.
//   - Cross-store or cross-scope entries are never grouped.
//   - Invalid/null analyzer output → needs-review, never an action.
//
// This module NEVER touches the stores. It consumes read-only inventories
// (MemoryStore.readInventory) and returns a plan; applying it is Task 5.
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

export interface GroupDecision {
  action: "merge" | "supersede";
  replacement: string;
  /** Index (within the group's members array) of the entry kept on supersede. */
  keepIndex?: number;
  rationale?: string;
}

export type GroupAnalyzer = (group: CandidateGroup) => Promise<GroupDecision | null>;

export interface PlanAction {
  id: string;
  type: "merge" | "supersede";
  store: StoreLabel;
  keep: { index: number; hash: string };
  remove: Array<{ index: number; hash: string }>;
  replacement: string;
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
    actionsValidated: number;
    rejectedToReview: number;
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

const CORRECTION_CUE =
  /\b(no longer|not\b|instead|actually|corrected|fix(?:ed)?|now uses|switched to|moved to|replaced by|replaced with|deprecated|outdated|superseded|updated to|wrong|incorrect|migration|renamed to)\b/i;

const SIMILARITY_THRESHOLD = 0.55;
const MIN_NORMALIZED_LENGTH = 40;
const MAX_GROUP_SIZE = 4;
const DEFAULT_MAX_GROUPS = 25;
const MERGE_TOKEN_COVERAGE = 0.8;
const MERGE_NEW_TOKEN_RATIO = 0.2;
const MERGE_NEW_TOKEN_ABS = 3;

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function significantTokens(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(" ")
      .filter((t) => t.length > 3 && !STOPWORDS.has(t)),
  );
}

/** Hard facts = numbers, dates, versions. Losing one is always a regression. */
export function hardFacts(text: string): Set<string> {
  return new Set(normalizeText(text).match(/\d+(?:\.\d+)*/g) ?? []);
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
  return createHash("sha256")
    .update(entries.map((e) => `${e.store}:${e.index}:${e.hash}`).join("|"))
    .digest("hex")
    .slice(0, 12);
}

export interface PlanCleanupOptions {
  analyze?: GroupAnalyzer | null;
  maxGroups?: number;
  now?: string;
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
  const maxGroups = opts.maxGroups ?? DEFAULT_MAX_GROUPS;

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

  const consumed = new Set<string>(); // entryIds already covered by an action

  // ---- Phase A: exact duplicates (decoded content + scope equality) -------
  const exactGroups = new Map<string, PlanningEntry[]>();
  for (const entry of all) {
    const norm = normalizeText(entry.text);
    if (!norm) continue;
    const key = `${scopeKey(entry)}::${norm}`;
    const list = exactGroups.get(key);
    if (list) list.push(entry);
    else exactGroups.set(key, [entry]);
  }
  for (const group of exactGroups.values()) {
    if (group.length < 2) continue;
    exactDuplicateGroups++;
    // Keep the most recently referenced member (tie: lowest index). The
    // replacement text is the shared text itself.
    const sorted = [...group].sort((a, b) =>
      b.lastReferenced.localeCompare(a.lastReferenced) || a.index - b.index,
    );
    const keep = sorted[0];
    const remove = sorted.slice(1);
    for (const e of remove) consumed.add(entryId(e));
    actions.push({
      id: planId(group),
      type: "merge",
      store: keep.store,
      keep: entryRef(keep),
      remove: remove.map(entryRef),
      replacement: keep.text,
      rationale: "Exact duplicate (identical normalized content and scope); kept the most recently referenced copy.",
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
        normalizeText(a.text).length < MIN_NORMALIZED_LENGTH ||
        normalizeText(b.text).length < MIN_NORMALIZED_LENGTH
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
    groups.push({ id: planId(group), members: group, similarity: sim });
  }
  groups.sort((x, y) => y.similarity - x.similarity);
  const bounded = groups.slice(0, maxGroups);
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
        actionsValidated,
        rejectedToReview,
      },
    };
  }

  for (const group of bounded) {
    let decision: GroupDecision | null = null;
    try {
      decision = await analyze(group);
    } catch {
      decision = null;
    }
    if (decision) analyzedGroups++;
    const review = (reason: string) => {
      rejectedToReview++;
      needsReview.push({
        store: group.members[0].store,
        entries: group.members.map((m) => ({ index: m.index, hash: m.hash, text: m.text })),
        reason,
      });
    };
    if (!decision) {
      review("Analyzer returned no usable decision for this group.");
      continue;
    }
    if (decision.action !== "merge" && decision.action !== "supersede") {
      review(`Unknown action "${String((decision as { action?: unknown }).action)}".`);
      continue;
    }
    const replacement = String(decision.replacement ?? "").trim();
    if (decision.action === "merge" && !normalizeText(replacement)) {
      review("Decision carried an empty replacement.");
      continue;
    }
    if (decision.action === "merge") {
      const result = validateMerge(group.members, replacement);
      if (!result.ok) {
        review(result.reason);
        continue;
      }
      actionsValidated++;
      actions.push({
        id: planId(group.members),
        type: "merge",
        store: group.members[0].store,
        keep: entryRef(group.members[0]),
        remove: group.members.slice(1).map(entryRef),
        replacement,
        rationale: decision.rationale ?? "Analyzer-validated merge of similar entries.",
      });
    } else {
      const keepIdx = typeof decision.keepIndex === "number" ? decision.keepIndex : -1;
      if (keepIdx < 0 || keepIdx >= group.members.length) {
        review("Supersede decision did not identify a surviving member.");
        continue;
      }
      const survivor = group.members[keepIdx];
      const victims = group.members.filter((_, i) => i !== keepIdx);
      const result = validateSupersede(survivor, victims);
      if (!result.ok) {
        review(result.reason);
        continue;
      }
      actionsValidated++;
      actions.push({
        id: planId(group.members),
        type: "supersede",
        store: survivor.store,
        keep: entryRef(survivor),
        remove: victims.map(entryRef),
        replacement: survivor.text,
        rationale: decision.rationale ?? "Explicit correction evidence validated.",
      });
    }
  }

  // Groups beyond the bound are reported, not analyzed.
  for (const group of groups.slice(maxGroups)) {
    needsReview.push({
      store: group.members[0].store,
      entries: group.members.map((m) => ({ index: m.index, hash: m.hash, text: m.text })),
      reason: `Analysis budget reached (${maxGroups} groups); left for a later pass.`,
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
      actionsValidated,
      rejectedToReview,
    },
  };
}

type ValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * merge: replacement must retain each member's hard facts, cover ≥80% of each
 * member's significant tokens, and not introduce meaningful unsupported facts.
 */
function validateMerge(members: PlanningEntry[], replacement: string): ValidationResult {
  const replTokens = significantTokens(replacement);
  const replFacts = hardFacts(replacement);
  const union = new Set<string>();
  for (const m of members) for (const t of significantTokens(m.text)) union.add(t);

  for (const m of members) {
    for (const fact of hardFacts(m.text)) {
      if (!replFacts.has(fact)) {
        return { ok: false, reason: `Replacement omits hard fact "${fact}" from "${truncate(m.text)}".` };
      }
    }
    const tokens = tokensOf(m.text);
    if (tokens.size) {
      let covered = 0;
      for (const t of tokens) if (replTokens.has(t)) covered++;
      if (covered / tokens.size < MERGE_TOKEN_COVERAGE) {
        return { ok: false, reason: `Replacement loses content of "${truncate(m.text)}" (coverage ${(covered / tokens.size).toFixed(2)}).` };
      }
    }
  }
  const novel = [...replTokens].filter((t) => !union.has(t));
  if (novel.length > MERGE_NEW_TOKEN_ABS && novel.length / Math.max(replTokens.size, 1) > MERGE_NEW_TOKEN_RATIO) {
    return { ok: false, reason: `Replacement introduces unsupported facts: ${truncate(novel.join(", "))}.` };
  }
  return { ok: true };
}

/**
 * supersede: survivor must carry an explicit correction cue, be at least as
 * recent as every victim, and contain every victim hard fact (a missing one
 * means conflicting versions/dates, not a correction).
 */
function validateSupersede(survivor: PlanningEntry, victims: PlanningEntry[]): ValidationResult {
  if (!CORRECTION_CUE.test(survivor.text)) {
    return {
      ok: false,
      reason: `No explicit correction cue in survivor "${truncate(survivor.text)}" — recency alone is not correction evidence.`,
    };
  }
  for (const victim of victims) {
    if (survivor.lastReferenced.localeCompare(victim.lastReferenced) < 0) {
      return { ok: false, reason: `Survivor is older than victim "${truncate(victim.text)}".` };
    }
    for (const fact of hardFacts(victim.text)) {
      if (!hardFacts(survivor.text).has(fact)) {
        return { ok: false, reason: `Victim hard fact "${fact}" missing from survivor — conflicting details, not a correction.` };
      }
    }
  }
  return { ok: true };
}

const tokenCache = new Map<string, Set<string>>();
function tokensOf(text: string): Set<string> {
  let t = tokenCache.get(text);
  if (!t) {
    t = significantTokens(text);
    if (tokenCache.size < 10_000) tokenCache.set(text, t);
  }
  return t;
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

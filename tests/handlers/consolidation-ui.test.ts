/**
 * Unit tests for consolidation TUI feedback helpers —
 * consolidationStatusText / isConsolidationSkipError / shortConsolidationFailureReason.
 * Pure functions: no mocks, no IO.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  consolidationStatusText,
  isConsolidationSkipError,
  shortConsolidationFailureReason,
} from "../../src/handlers/auto-consolidate.js";

describe("consolidationStatusText", () => {
  it("formats the footer status for each tool target", () => {
    assert.equal(consolidationStatusText("memory"), "🧹 memory consolidating — memory…");
    assert.equal(consolidationStatusText("user"), "🧹 memory consolidating — user…");
    assert.equal(consolidationStatusText("failure"), "🧹 memory consolidating — failure…");
    assert.equal(consolidationStatusText("project"), "🧹 memory consolidating — project…");
  });
});

describe("isConsolidationSkipError", () => {
  const skipResult = {
    consolidated: false,
    error: "Consolidation still in progress for target 'memory' after wait, skipping.",
  };

  it("classifies the lock-contention skip as a skip", () => {
    assert.equal(isConsolidationSkipError(skipResult), true);
  });

  it("does NOT classify missing error, real failures, or termination as a skip", () => {
    assert.equal(isConsolidationSkipError({ consolidated: false }), false);
    assert.equal(
      isConsolidationSkipError({ consolidated: false, error: "Consolidation process exited with code 1: boom" }),
      false,
    );
    assert.equal(
      isConsolidationSkipError({
        consolidated: false,
        error: "Consolidation subprocess was terminated (likely timeout or cancellation). Timeout: 1800000ms.",
      }),
      false,
    );
  });
});

describe("shortConsolidationFailureReason", () => {
  it("returns the placeholder for empty or undefined reasons", () => {
    assert.equal(shortConsolidationFailureReason(), "no reason reported");
    assert.equal(shortConsolidationFailureReason(""), "no reason reported");
  });

  it("collapses newlines and whitespace runs to single spaces", () => {
    assert.equal(
      shortConsolidationFailureReason("line one\nline two\r\n\nline    three"),
      "line one line two line three",
    );
  });

  it("hard-caps the reason at 120 chars", () => {
    const long = "x".repeat(300);
    const short = shortConsolidationFailureReason(long);
    assert.equal(short.length, 120);
    assert.equal(short, "x".repeat(120));
  });

  it("passes through a plain short reason unchanged", () => {
    assert.equal(shortConsolidationFailureReason("child exited code 1"), "child exited code 1");
  });
});

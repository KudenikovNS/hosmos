// =============================================================================
// WHICH OF THE FOUR STATES THE KPI BLOCK IS IN (T5.9) — DB-less.
//
// `dashboard.integration.test.ts` proves that each state is REACHED by the
// situation that should reach it (a revision nobody calculated, a run with a
// missing factor, a boundary redrawn afterwards). This file is about the
// decision itself, which is a truth table, and the two cases in it that a
// database test would only ever hit by accident: a run that is BOTH failed and
// stale, and the difference between "no run" and "a run that published nothing".
// =============================================================================
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { emissionState } from "../dashboard";

describe("emissionState — the four states, and not one of them is a zero", () => {
  it("is `no_run` when the approved revision was never calculated", () => {
    expect(
      emissionState({ hasRun: false, aggregateStatus: null, stale: false }),
    ).toBe("no_run");
    // …and stays `no_run` even though CALC-6 reports an uncalculated revision
    // with rows as stale. "Recalculate" is not the first thing to say to a
    // report that has never been calculated at all.
    expect(
      emissionState({ hasRun: false, aggregateStatus: null, stale: true }),
    ).toBe("no_run");
  });

  it("is `ok` for a complete run that still describes its inputs", () => {
    expect(
      emissionState({ hasRun: true, aggregateStatus: "ok", stale: false }),
    ).toBe("ok");
  });

  it("is `stale` when an input moved after a complete run (CALC-6)", () => {
    expect(
      emissionState({ hasRun: true, aggregateStatus: "ok", stale: true }),
    ).toBe("stale");
  });

  it("is `failed` when a line could not be priced (§0.7)", () => {
    expect(
      emissionState({ hasRun: true, aggregateStatus: "failed", stale: false }),
    ).toBe("failed");
  });

  it("prefers `failed` over `stale` when a run is both", () => {
    // A run that published NO figure cannot usefully be described as "out of
    // date" — there is nothing to be out of date. And "your rows moved,
    // recalculate" would send the user to fix the wrong thing: a failed line is
    // a missing factor or an unconvertible unit, not a stale input.
    expect(
      emissionState({ hasRun: true, aggregateStatus: "failed", stale: true }),
    ).toBe("failed");
  });
});

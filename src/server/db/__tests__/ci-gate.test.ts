// =============================================================================
// THE GATE MUST NOT PASS BY SKIPPING.
//
// `describeIntegration` is `describe.skip` when no Postgres answers, and that is
// the right behaviour for a laptop with no docker up: the pure engine suites
// stay green and nothing is red for a reason that is not a defect. It is exactly
// the WRONG behaviour for the merge gate. `.github/workflows/deploy.yml` runs on
// a push to `main` and decides whether the artefact is deployed — and until it
// grew a Postgres service, every `describeIntegration` suite on it was skipped:
// the reproducibility proof (AC-8), the acceptance-criteria suites, the render
// tests and every route test. A green tick meant "the pure tests passed", while
// reading as "the tests passed".
//
// A skipped suite is invisible in a summary line — `npm test` prints the same
// cheerful count whether 40 files ran or 20 did — so the absence has to be made
// LOUD somewhere, and this is the only kind of test that can do it: an UNGATED
// one, which runs precisely when the DB-backed ones do not.
//
// It is a no-op locally on purpose. `CI` is set to `"true"` by GitHub Actions
// (and by essentially every other runner); a developer without docker up is not
// the gate and must not be failed by it.
// =============================================================================
import { describe, expect, it } from "vitest";

import { dbReady } from "./harness";

describe("the integration gate", () => {
  it("really has a Postgres when it is CI that is running", () => {
    if (process.env.CI !== "true") {
      // Locally the DB is optional; say so out loud rather than passing mutely.
      expect(process.env.CI ?? "unset").not.toBe("true");
      return;
    }
    expect(
      dbReady,
      "DATABASE_URL is unreachable in CI, so every `describeIntegration` suite " +
        "was SKIPPED and the run proves nothing about the database half of this " +
        "codebase. Check the `postgres` service and the DATABASE_URL of the " +
        "test step in .github/workflows/deploy.yml.",
    ).toBe(true);
  });
});

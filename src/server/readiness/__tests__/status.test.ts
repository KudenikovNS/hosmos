import { describe, expect, it } from "vitest";

import {
  datapointStatus,
  emptyCounts,
  isApplicable,
  readinessPercent,
  type DatapointFacts,
} from "../status";

const base: DatapointFacts = {
  requirement: "mandatory",
  quantitative: true,
  derived: null,
  record: null,
  decision: null,
};

describe("datapointStatus (spec §5.2)", () => {
  it("a stored decision wins over everything else", () => {
    expect(
      datapointStatus({
        ...base,
        decision: "not_applicable",
        record: { state: "approved", hasValue: true, evidenceCount: 3 },
      }),
    ).toBe("not_applicable");
    expect(datapointStatus({ ...base, decision: "sensitive_omitted" })).toBe(
      "sensitive_omitted",
    );
  });

  it("a derived datapoint is ready when its source yields a value, a gap otherwise", () => {
    expect(datapointStatus({ ...base, derived: "present" })).toBe("ready");
    expect(datapointStatus({ ...base, derived: "missing" })).toBe("needs_data");
  });

  it("an approved record is ready", () => {
    expect(
      datapointStatus({
        ...base,
        record: { state: "approved", hasValue: true, evidenceCount: 0 },
      }),
    ).toBe("ready");
  });

  it("a draft figure with no document behind it needs evidence; with one, confirmation", () => {
    expect(
      datapointStatus({
        ...base,
        record: { state: "draft", hasValue: true, evidenceCount: 0 },
      }),
    ).toBe("needs_evidence");
    expect(
      datapointStatus({
        ...base,
        record: { state: "draft", hasValue: true, evidenceCount: 1 },
      }),
    ).toBe("needs_confirmation");
  });

  it("a draft NARRATIVE answer never asks for evidence, only for confirmation", () => {
    expect(
      datapointStatus({
        ...base,
        quantitative: false,
        record: { state: "draft", hasValue: true, evidenceCount: 0 },
      }),
    ).toBe("needs_confirmation");
  });

  it("no record: mandatory is a gap, conditional/voluntary is an open question", () => {
    expect(datapointStatus(base)).toBe("needs_data");
    expect(datapointStatus({ ...base, requirement: "conditional" })).toBe(
      "open_conditional",
    );
    expect(datapointStatus({ ...base, requirement: "voluntary" })).toBe(
      "open_conditional",
    );
  });
});

describe("readiness arithmetic", () => {
  it("excludes decisions and open questions from the denominator", () => {
    expect(isApplicable("not_applicable")).toBe(false);
    expect(isApplicable("sensitive_omitted")).toBe(false);
    expect(isApplicable("open_conditional")).toBe(false);
    expect(isApplicable("needs_evidence")).toBe(true);
  });

  it("is ready / applicable, rounded, and 0 when nothing applies", () => {
    const counts = emptyCounts();
    expect(readinessPercent(counts)).toBe(0);
    counts.ready = 2;
    counts.needs_data = 1;
    counts.open_conditional = 10;
    expect(readinessPercent(counts)).toBe(67);
  });
});

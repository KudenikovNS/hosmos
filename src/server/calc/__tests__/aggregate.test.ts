// CALC-8 unit tests — NO DATABASE. `aggregateRun` is pure, and the rules worth
// testing here are the ones where it REFUSES to publish a figure rather than
// invent one:
//
//   - a missing `renewable_share` withholds the SPLIT and keeps the total;
//   - an unconvertible row withholds the whole bucket, total included;
//   - no missing input is ever read as a zero, in either case.
//
// The arithmetic itself (how 1 MWh at 40% divides) is covered end to end by
// `calc.integration.test.ts`; what needs a suite of its own is the boundary
// between "we know this" and "we do not", because that is where a `?? 0` gets
// written by accident and a report starts making claims nobody entered.
import { describe, expect, it } from "vitest";

import {
  aggregateRun,
  type AggregateEnergyRow,
  type AggregateEntity,
  type AggregateInput,
} from "../aggregate";

const ENTITY_A = "11111111-1111-4111-8111-111111111111";
const ENTITY_B = "22222222-2222-4222-8222-222222222222";
const SITE_A = "33333333-3333-4333-8333-333333333333";

const entity = (id: string, name: string): AggregateEntity => ({
  legalEntityId: id,
  name,
  turnover: "1000000",
  currency: "EUR",
});

/** An energy row: 100 MWh, 40% renewable, at site A of entity A. */
function energyRow(
  id: string,
  overrides: Partial<AggregateEnergyRow> = {},
): AggregateEnergyRow {
  return {
    energyRowId: id,
    legalEntityId: ENTITY_A,
    facilityId: SITE_A,
    energyType: "electricity",
    consumptionMwh: "100.000000",
    renewableShare: "40",
    ...overrides,
  };
}

function input(overrides: Partial<AggregateInput> = {}): AggregateInput {
  return {
    lines: [],
    energy: [],
    entities: [entity(ENTITY_A, "Entity A")],
    facilities: [
      { facilityId: SITE_A, legalEntityId: ENTITY_A, name: "Site A" },
    ],
    fx: { year: "2024", rates: new Map([["EUR", 1]]) },
    ...overrides,
  };
}

const codes = (result: ReturnType<typeof aggregateRun>) =>
  result.warnings.map((w) => w.code);

describe("aggregateRun — the energy split (CALC-8, VSME B3)", () => {
  it("divides a stated share", () => {
    const result = aggregateRun(input({ energy: [energyRow("e1")] }));

    expect(result.energy).toEqual({
      totalMwh: "100.000000",
      renewableMwh: "40.000000",
      nonRenewableMwh: "60.000000",
    });
    expect(codes(result)).not.toContain("renewable_share_missing");
  });

  it("does NOT report a missing share as fossil energy", () => {
    // THE DEFECT, as a test. An unstated share used to be read as `renewable =
    // 0`, which put the WHOLE volume on `nonRenewableMwh` — a positive claim,
    // about energy whose provenance nobody recorded, that it was certainly not
    // renewable. The volume is real and stays in the total; the split is not
    // published at all, and the warning names the row to fill in.
    const result = aggregateRun(
      input({ energy: [energyRow("e1", { renewableShare: null })] }),
    );

    expect(result.energy.totalMwh).toBe("100.000000");
    expect(result.energy.renewableMwh).toBeNull();
    expect(result.energy.nonRenewableMwh).toBeNull();
    // Not "0.000000" and not "100.000000" — no number at all.
    expect(result.energy.nonRenewableMwh).not.toBe("100.000000");
    expect(codes(result)).toContain("renewable_share_missing");
    expect(result.warnings[0].detail).toMatchObject({ energy_row_id: "e1" });
  });

  it("withholds the split of every bucket the unstated row joined — and only those", () => {
    // Entity A has one row with a share and one without; entity B has a clean
    // one. The doubt is contained: it reaches A's split and the grand split
    // (both of which include the unstated row), and nothing else.
    const result = aggregateRun(
      input({
        entities: [entity(ENTITY_A, "Entity A"), entity(ENTITY_B, "Entity B")],
        energy: [
          energyRow("e1"),
          energyRow("e2", { renewableShare: null }),
          energyRow("e3", {
            legalEntityId: ENTITY_B,
            facilityId: null,
            consumptionMwh: "10.000000",
            renewableShare: "100",
          }),
        ],
      }),
    );

    expect(result.energy.totalMwh).toBe("210.000000");
    expect(result.energy.renewableMwh).toBeNull();

    const byEntity = new Map(
      result.byLegalEntity.map((e) => [e.legalEntityId, e.energy]),
    );
    expect(byEntity.get(ENTITY_A)).toEqual({
      totalMwh: "200.000000",
      renewableMwh: null,
      nonRenewableMwh: null,
    });
    expect(byEntity.get(ENTITY_B)).toEqual({
      totalMwh: "10.000000",
      renewableMwh: "10.000000",
      nonRenewableMwh: "0.000000",
    });
  });

  it("withholds EVERYTHING for an unconvertible row, the total included", () => {
    // The stronger refusal, and the reason there are two flags: this volume
    // never reached MWh at all, so the total is as unknown as the split.
    const result = aggregateRun(
      input({
        energy: [energyRow("e1"), energyRow("e2", { consumptionMwh: null })],
      }),
    );

    expect(result.energy).toEqual({
      totalMwh: null,
      renewableMwh: null,
      nonRenewableMwh: null,
    });
    expect(codes(result)).toContain("energy_unconvertible");
  });
});

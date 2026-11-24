import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsx } from "react/jsx-runtime";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../../../messages/ru.json";
import type { ReadinessDto } from "@/server/readiness/readiness";
import { emptyCounts } from "@/server/readiness/status";

const { useListMock } = vi.hoisted(() => ({ useListMock: vi.fn() }));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("a", props, children),
}));
vi.mock("@/shared/hooks/useCapabilities", () => ({
  useCapabilities: () => new Set(["data.write"]),
}));
vi.mock("../../inventory/_lib/useInventory", () => ({
  useList: useListMock,
}));
vi.mock("../../_components/PageLayout", () => ({
  PageLayout: ({ children }: { children?: ReactNode }) =>
    createElement("main", null, children),
}));
vi.mock("../_components/JourneyBar", () => ({ JourneyBar: () => null }));
vi.mock("../_components/DisclosureCard", () => ({
  DisclosureCard: () => null,
}));

import ReadinessPage from "../page";

const period: NonNullable<ReadinessDto["period"]> = {
  id: "period",
  name: "2026",
  start_date: "2026-01-01",
  end_date: "2026-12-31",
  reporting_year: 2026,
  reporting_basis: "individual",
};

function render(overrides: Partial<ReadinessDto>, loadError = false) {
  const data: ReadinessDto = {
    has_legal_entity: true,
    period: null,
    revision: null,
    plan: { id: "trial", module: "basic", simplified_esrs: false },
    summary: { ...emptyCounts(), applicable: 0, percent: 0 },
    disclosures: [],
    journey: [],
    next: "organisation",
    can_decide: false,
    esrs: {
      available: false,
      required_plan: "pro",
      coverage: { vsme_mapped: 0, vsme_mapped_ready: 0, additional: 0 },
    },
    ...overrides,
  };
  useListMock.mockReturnValue({
    data,
    loading: false,
    accessChanged: false,
    loadError,
  });
  return renderToStaticMarkup(
    jsx(NextIntlClientProvider, {
      locale: "ru",
      timeZone: "Europe/Ljubljana",
      messages,
      children: createElement(ReadinessPage),
    }),
  );
}

describe("readiness setup prompts", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([null, period])(
    "shows the legal entity prompt when no entity exists, period=%s",
    (remainingPeriod) => {
      const html = render({ has_legal_entity: false, period: remainingPeriod });
      expect(html).toContain(messages.common.noLegalEntity.title);
      expect(html).toContain('href="/organisation"');
      expect(html).not.toContain(messages.common.noReportingPeriod.title);
      expect(html).not.toContain('id="readiness-summary"');
    },
  );

  it("shows the period prompt after a legal entity has been created", () => {
    const html = render({ has_legal_entity: true });
    expect(html).toContain(messages.common.noReportingPeriod.title);
    expect(html).not.toContain(messages.common.noLegalEntity.title);
  });

  it("shows the report when both the legal entity and period exist", () => {
    const html = render({ has_legal_entity: true, period });
    expect(html).toContain('id="readiness-summary"');
    expect(html).not.toContain(messages.common.noLegalEntity.title);
    expect(html).not.toContain(messages.common.noReportingPeriod.title);
  });

  it("does not turn a loading failure into a missing-entity prompt", () => {
    const html = render({ has_legal_entity: false }, true);
    expect(html).toContain(messages.readiness.errors.loadFailed);
    expect(html).not.toContain(messages.common.noLegalEntity.title);
  });
});

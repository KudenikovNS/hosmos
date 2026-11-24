import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsx } from "react/jsx-runtime";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../../../messages/ru.json";
import { PLAN_FEATURES, type PlanId } from "@/shared/plans";

const { state, write } = vi.hoisted(() => ({
  state: {
    hasEntity: false,
    hasPeriod: true,
    entityLoading: false,
    entityError: false,
    entityAccessChanged: false,
    plan: "trial" as PlanId,
    approved: false,
  },
  write: vi.fn(),
}));

const ready = { loading: false, accessChanged: false, loadError: false };
const period = {
  id: "period",
  period_name: "FY2026",
  start_date: "2026-01-01",
  end_date: "2026-12-31",
  reporting_basis: "individual",
  period_status: "Draft",
  factor_set_version: "test",
};

function periods() {
  return { ...ready, periods: state.hasPeriod ? [period] : [] };
}

function revisions() {
  return {
    ...ready,
    currentRevisionId: state.hasPeriod ? "revision" : null,
    revisions: state.hasPeriod
      ? [
          {
            id: "revision",
            revision_no: 1,
            status: state.approved ? "approved" : "draft",
          },
        ]
      : [],
  };
}

function facilities() {
  return { ...ready, facilities: [] };
}

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("a", props, children),
}));
vi.mock("@/shared/hooks/useCapabilities", () => ({
  useCapabilities: () => ({
    capabilities: [
      "data.read",
      "data.write",
      "data.submit",
      "data.review",
      "data.approve",
      "company.manage",
      "audit.read",
    ],
    has: () => true,
  }),
}));
vi.mock("@/shared/hooks/usePlan", () => ({
  usePlan: () => ({ features: PLAN_FEATURES[state.plan], mode: "active" }),
}));
vi.mock("@/shared/hooks/useSession", () => ({
  useCompany: () => ({
    company: { id: "company", plan: state.plan },
    loading: false,
  }),
  useSession: () => ({
    data: { membership: { hasIndependentApprover: true } },
  }),
}));
vi.mock("../PageLayout", () => ({
  PageLayout: ({
    children,
    loading,
  }: {
    children?: ReactNode;
    loading?: boolean;
  }) =>
    createElement(
      "main",
      loading ? { "data-loading": true } : null,
      loading ? null : children,
    ),
}));
vi.mock("../../organisation/_lib/useOrganisation", () => ({
  useLegalEntities: () => ({
    entities: state.hasEntity
      ? [{ id: "entity", organisation_name: "Test", country: "SI" }]
      : [],
    loading: state.entityLoading,
    loadError: state.entityError,
    accessChanged: state.entityAccessChanged,
  }),
  useFacilities: () => facilities(),
  useAssets: () => ({ ...ready, assets: [] }),
}));
vi.mock("../../inventory/_lib/useInventory", () => ({
  usePeriods: () => periods(),
  useRevisions: () => revisions(),
  useInventoryRows: () => ({ ...ready, rows: [], truncated: false }),
  useRowWrites: () => ({ create: write }),
  useMemberNames: () => () => "Tester",
  useList: () => ({
    ...ready,
    data: {
      period: state.hasPeriod ? period : null,
      revision: null,
      rows: null,
      validation: null,
      emissions: null,
    },
  }),
}));
vi.mock("../../inventory/disclosures/_lib/useDisclosures", () => ({
  useMetrics: () => ({ ...ready, metrics: [] }),
  useDisclosureRecords: () => ({ ...ready, records: [] }),
  useDisclosureWrites: () => ({ create: write, edit: write, approve: write }),
}));
vi.mock("../../inventory/_components/NewRowForm", () => ({
  NewRowForm: () => createElement("form", { "data-editor": "inventory" }),
}));
vi.mock("../../evidence/_lib/useEvidence", () => ({
  useDocuments: () => ({
    ...ready,
    documents: [{ id: "document", file_name: "saved-document.pdf" }],
  }),
  useEvidenceLinks: () => ({ ...ready, links: [] }),
  useInventoryRows: () => ({ ...ready, rows: [], truncated: false }),
  useEvidenceWrites: () => ({}),
  useUpload: () => write,
  useAssessment: () => ({ ...ready, assessment: null }),
  useRowVersions: () => ({ ...ready, versions: [] }),
  useAuditTrail: () => ({ ...ready, entries: [] }),
}));
vi.mock("../../evidence/_components/UploadPanel", () => ({
  UploadPanel: () => createElement("form", { "data-upload": true }),
}));
vi.mock("../../evidence/_components/DocumentTable", () => ({
  DocumentFilters: () => null,
  DocumentTable: () => createElement("div", null, "saved-document.pdf"),
}));
vi.mock("../../review/_lib/useReview", () => ({
  useBoundary: () => ({ ...ready, entries: [] }),
  useFacilities: () => facilities(),
  useValidation: () => ({ ...ready, results: [], blocking: [] }),
  useTransition: () => write,
  useCalculate: () => write,
  useRowApprovals: () => write,
  useNewRevision: () => write,
}));
vi.mock("../../review/_components/RevisionPanel", () => ({
  RevisionPanel: () => createElement("div", { "data-editor": "review" }),
}));
vi.mock("../../reports/_lib/useReports", () => ({
  usePeriods: () => periods(),
  useRevisions: () => revisions(),
  useRenderPreview: () => ({ ...ready, preview: null }),
  useRenderRevision: () => write,
  useRenders: () => ({
    ...ready,
    renders: [{ id: "render", file_name: "saved-report.pdf" }],
  }),
}));
vi.mock("../../reports/_components/RenderForm", () => ({
  RenderForm: () => createElement("form", { "data-editor": "report" }),
}));
vi.mock("../../reports/_components/RenderList", () => ({
  RenderList: () => createElement("div", null, "saved-report.pdf"),
}));

import DashboardPage from "../../dashboard/page";
import InventoryPage from "../../inventory/page";
import DisclosuresPage from "../../inventory/disclosures/page";
import EvidencePage from "../../evidence/page";
import ReviewPage from "../../review/page";
import ReportsPage from "../../reports/page";

const pages = [
  { name: "dashboard", component: DashboardPage },
  { name: "inventory", component: InventoryPage },
  { name: "disclosures", component: DisclosuresPage },
  { name: "evidence", component: EvidencePage },
  { name: "review", component: ReviewPage },
  { name: "reports", component: ReportsPage },
];

function render(component: ComponentType) {
  return renderToStaticMarkup(
    jsx(NextIntlClientProvider, {
      locale: "ru",
      timeZone: "Europe/Ljubljana",
      messages,
      children: createElement(component),
    }),
  );
}

describe.each(pages)("$name: legal entity setup", ({ component, name }) => {
  beforeEach(() => {
    Object.assign(state, {
      hasEntity: false,
      hasPeriod: true,
      entityLoading: false,
      entityError: false,
      entityAccessChanged: false,
      plan: "trial",
      approved: name === "reports",
    });
    vi.clearAllMocks();
  });

  it.each(["trial", "starter", "pro", "enterprise"] as const)(
    "%s shows the entity prompt before period and draft prompts",
    (plan) => {
      state.plan = plan;
      for (const hasPeriod of [false, true]) {
        state.hasPeriod = hasPeriod;
        const html = render(component);
        expect(html).toContain(messages.common.noLegalEntity.title);
        expect(html).toContain('href="/organisation"');
        expect(html).not.toContain(messages.common.noReportingPeriod.title);
        expect(html).not.toContain(messages.common.noReportRevision.title);
        expect(html).not.toContain("data-editor=");
        expect(html).not.toContain('id="disclosures-entity"');
        expect(write).not.toHaveBeenCalled();
      }
    },
  );

  it("shows the report workspace after the legal entity is created", () => {
    state.hasEntity = true;
    const html = render(component);
    expect(html).not.toContain(messages.common.noLegalEntity.title);
    expect(html).toContain("FY2026");
    if (name === "inventory") expect(html).toContain('data-editor="inventory"');
    if (name === "disclosures")
      expect(html).toContain('id="disclosures-entity"');
    if (name === "review") expect(html).toContain('data-editor="review"');
    if (name === "reports") expect(html).toContain('data-editor="report"');
  });

  it("shows the period prompt only after an entity exists", () => {
    state.hasEntity = true;
    state.hasPeriod = false;
    expect(render(component)).toContain(
      messages.common.noReportingPeriod.title,
    );
  });

  it("does not mistake a pending entity request for an empty registry", () => {
    state.entityLoading = true;
    const html = render(component);
    expect(html).not.toContain(messages.common.noLegalEntity.title);
    expect(html).not.toContain(messages.common.noReportingPeriod.title);
    expect(html).not.toContain("data-editor=");
  });

  it.each(["entityError", "entityAccessChanged"] as const)(
    "%s shows an error rather than setup instructions",
    (failure) => {
      state[failure] = true;
      const html = render(component);
      expect(html).toContain('role="alert"');
      expect(html).not.toContain(messages.common.noLegalEntity.title);
      expect(html).not.toContain(messages.common.noReportingPeriod.title);
      expect(html).not.toContain("data-editor=");
    },
  );

  if (name === "evidence" || name === "reports") {
    it("keeps saved files accessible without an entity and during entity request failures", () => {
      for (const condition of ["missing", "loading", "error"] as const) {
        state.entityLoading = condition === "loading";
        state.entityError = condition === "error";
        const html = render(component);
        expect(html).toContain(
          name === "evidence" ? "saved-document.pdf" : "saved-report.pdf",
        );
        if (name === "evidence") expect(html).toContain("data-upload=");
        expect(html).not.toContain("data-editor=");
      }
    });
  }
});

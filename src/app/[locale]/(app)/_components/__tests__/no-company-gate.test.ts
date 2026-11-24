// BUG-004: a signed-in account without a company sees the "create your
// company" step instead of an empty product screen; every other session state
// renders the page unchanged.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsx } from "react/jsx-runtime";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../../../messages/ru.json";

const { session } = vi.hoisted(() => ({
  session: { data: undefined as unknown },
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("a", props, children),
}));
vi.mock("@/shared/hooks/useSession", () => ({
  SESSION_QUERY_KEY: ["session"],
  useSession: () => ({ data: session.data }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../PageLayout", () => ({
  PageLayout: ({ title, children }: { title: string; children?: ReactNode }) =>
    createElement("main", { "data-title": title }, children),
}));

import { NoCompanyGate } from "../NoCompanyGate";

function render() {
  return renderToStaticMarkup(
    jsx(NextIntlClientProvider, {
      locale: "ru",
      timeZone: "Europe/Ljubljana",
      messages,
      children: createElement(
        NoCompanyGate,
        null,
        createElement("p", null, "PAGE"),
      ),
    }),
  );
}

describe("NoCompanyGate", () => {
  beforeEach(() => {
    session.data = undefined;
  });

  it("renders the page while the session is loading or unreadable", () => {
    expect(render()).toContain("PAGE");
  });

  it("renders the page for a signed-out response", () => {
    session.data = null;
    expect(render()).toContain("PAGE");
  });

  it("renders the page when the account has a company", () => {
    session.data = { userId: "u", company: { id: "c" } };
    expect(render()).toContain("PAGE");
  });

  it("offers to create a company when the account has none", () => {
    session.data = { userId: "u", company: null, memberships: [] };
    const html = render();
    expect(html).not.toContain("PAGE");
    expect(html).toContain(messages.common.noCompany.title);
    expect(html).toContain(messages.common.noCompany.create);
    expect(html).toContain(messages.common.noCompany.invited);
  });
});

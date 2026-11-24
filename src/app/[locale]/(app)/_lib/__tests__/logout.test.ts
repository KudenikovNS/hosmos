// BUG-001 — «after Log out the screen stays as it was». One cause, seen in the
// user's console: the sign-out request failed (`TypeError: Failed to fetch`,
// raised inside a browser extension that wraps `fetch`), the rejection went
// unhandled and the navigation after it never ran.
import { describe, expect, it, vi } from "vitest";

import { logOut } from "../logout";

const deps = (signOut: () => Promise<{ error: unknown }>) => ({
  signOut,
  navigate: vi.fn(),
  onFailure: vi.fn(),
  loginUrl: "/ru/login",
});

describe("logOut", () => {
  it("leaves for the login page with a full load once the session is closed", async () => {
    const d = deps(async () => ({ error: null }));
    await expect(logOut(d)).resolves.toBe(true);
    expect(d.navigate).toHaveBeenCalledWith("/ru/login");
    expect(d.onFailure).not.toHaveBeenCalled();
  });

  it("says so, instead of rejecting unhandled, when the request does not get through", async () => {
    const d = deps(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(logOut(d)).resolves.toBe(false);
    expect(d.onFailure).toHaveBeenCalledOnce();
    expect(d.navigate).not.toHaveBeenCalled();
  });

  it("treats an error answer as a failure: the session may still be open", async () => {
    const d = deps(async () => ({ error: { status: 500 } }));
    await expect(logOut(d)).resolves.toBe(false);
    expect(d.onFailure).toHaveBeenCalledOnce();
    expect(d.navigate).not.toHaveBeenCalled();
  });
});

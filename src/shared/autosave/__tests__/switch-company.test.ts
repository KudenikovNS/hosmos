import { describe, expect, it, vi } from "vitest";
import { confirmCompanySwitch } from "../switch-company";

describe("F09: reconciling the server-side company", () => {
  it("waits for the switch before reading the authoritative session", async () => {
    const order: string[] = [];
    const session = { company: { id: "B" }, features: "new permissions" };
    const result = await confirmCompanySwitch(
      "B",
      async () => {
        order.push("POST");
      },
      async () => {
        order.push("GET");
        return session;
      },
    );
    expect(order).toEqual(["POST", "GET"]);
    expect(result).toBe(session);
  });
  it("a lost POST response may still mean a successful switch", async () => {
    const session = { company: { id: "B" } };
    expect(
      await confirmCompanySwitch(
        "B",
        async () => {
          throw Error("offline");
        },
        async () => session,
      ),
    ).toBe(session);
  });
  it("cannot resume A after an uncertain POST while the server could still commit B", async () => {
    await expect(
      confirmCompanySwitch(
        "B",
        async () => {
          throw Error("offline");
        },
        async () => ({ company: { id: "A" } }),
      ),
    ).rejects.toThrow("not confirmed");
  });
  it("a completed refusal can safely keep the original company and its drafts", async () => {
    const session = { company: { id: "A" } };
    expect(
      await confirmCompanySwitch(
        "B",
        async () => ({ ok: false }),
        async () => session,
      ),
    ).toBe(session);
  });
  it("does not permit writes when the refreshed session is missing or fails", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    await expect(
      confirmCompanySwitch("B", post, async () => null),
    ).rejects.toThrow("not confirmed");
    await expect(
      confirmCompanySwitch("B", post, async () => {
        throw Error("session offline");
      }),
    ).rejects.toThrow("session offline");
  });
});

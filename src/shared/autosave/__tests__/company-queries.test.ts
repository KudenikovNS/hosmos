import { QueryClient, isCancelledError } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { companyQueryKey, invalidateCompanyQueries } from "../company-queries";

describe("F09: company-scoped query cache", () => {
  it("a delayed A response never replaces B's data at the same resource path", async () => {
    const client = new QueryClient();
    let resolve!: (value: string) => void;
    const a = client.fetchQuery({
      queryKey: companyQueryKey(["org", "entities"], "A"),
      queryFn: () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    });
    await client.fetchQuery({
      queryKey: companyQueryKey(["org", "entities"], "B"),
      queryFn: async () => "Company B",
    });
    resolve("Company A");
    await a;
    expect(client.getQueryData(companyQueryKey(["org", "entities"], "B"))).toBe(
      "Company B",
    );
    client.clear();
  });
  it("invalidates A's collection and dependent revisions without invalidating B", async () => {
    const client = new QueryClient();
    const a = companyQueryKey(["periods"], "A"),
      b = companyQueryKey(["periods"], "B");
    const revisions = companyQueryKey(
      ["periods", "period-a", "revisions"],
      "A",
    );
    for (const key of [a, b, revisions]) client.setQueryData(key, []);
    await invalidateCompanyQueries(client, ["periods"], "A");
    expect(client.getQueryState(a)?.isInvalidated).toBe(true);
    expect(client.getQueryState(revisions)?.isInvalidated).toBe(true);
    expect(client.getQueryState(b)?.isInvalidated).toBe(false);
    // Existing broad resource invalidations must still reach all scoped keys.
    await client.invalidateQueries({ queryKey: ["periods"] });
    expect(client.getQueryState(b)?.isInvalidated).toBe(true);
    client.clear();
  });
  it("cancels an old GET before switching and ignores its late result", async () => {
    const client = new QueryClient();
    let signal!: AbortSignal;
    let resolve!: (value: string) => void;
    const key = companyQueryKey(["org", "entities"], "A");
    const old = client
      .fetchQuery({
        queryKey: key,
        queryFn: (context) => {
          signal = context.signal;
          return new Promise<string>((done) => {
            resolve = done;
          });
        },
      })
      .catch((error: unknown) => error);
    await client.cancelQueries();
    expect(signal.aborted).toBe(true);
    resolve("Old A data");
    expect(isCancelledError(await old)).toBe(true);
    expect(client.getQueryData(key)).toBeUndefined();
    client.clear();
  });
});

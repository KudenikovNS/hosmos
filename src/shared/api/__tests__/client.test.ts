// T-18: apiFetch — HTTP-клиент на BACKEND_URL (PG-IMPL-SPEC §4.3, §3.5).
//
// Инварианты, которые фиксируют тесты:
//  - база URL выбирается по среде: сервер → BACKEND_URL, браузер →
//    NEXT_PUBLIC_BACKEND_URL;
//  - на сервере (RSC/route/SSR) входящие cookie из next/headers прокидываются в
//    заголовок Cookie к BACKEND_URL;
//  - в браузере cookie не читаются (нет next/headers), стоит credentials:include;
//  - cache:"no-store" всегда; тело парсится как JSON (ActionResult<T> на месте);
//  - отсутствие базового URL → понятная ошибка (guard).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next/headers доступен только на сервере; в клиентской ветке apiFetch его не
// импортирует. Мокаем, чтобы серверная ветка отдавала предсказуемую cookie.
const cookiesMock = vi.fn(async () => ({
  toString: (): string => "session=abc",
}));
vi.mock("next/headers", () => ({ cookies: () => cookiesMock() }));

import { apiFetch } from "@/shared/api/client";

const ENV_KEYS = ["BACKEND_URL", "NEXT_PUBLIC_BACKEND_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  cookiesMock.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

describe("apiFetch (server-side)", () => {
  it("uses BACKEND_URL and forwards the incoming cookie from next/headers", async () => {
    process.env.BACKEND_URL = "https://api.example.com";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, data: { hi: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiFetch<{ ok: true; data: { hi: number } }>(
      "/api/session",
    );

    expect(result).toEqual({ ok: true, data: { hi: 1 } });
    expect(cookiesMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/api/session");
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("include");
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe("session=abc");
  });

  it("strips a trailing slash from the base URL", async () => {
    process.env.BACKEND_URL = "https://api.example.com/";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, data: null }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/session");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.example.com/api/session",
    );
  });

  it("throws a clear error when BACKEND_URL is missing on the server", async () => {
    delete process.env.BACKEND_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/session")).rejects.toThrow(/BACKEND_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves caller headers, method and body while adding the cookie", async () => {
    process.env.BACKEND_URL = "https://api.example.com";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, data: null }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/company/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ plan: "pro" }));
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("cookie")).toBe("session=abc");
  });
});

describe("apiFetch (browser)", () => {
  beforeEach(() => {
    // Симулируем браузер: typeof window !== "undefined".
    vi.stubGlobal("window", {} as unknown as Window);
  });

  it("uses NEXT_PUBLIC_BACKEND_URL and never reads next/headers", async () => {
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://public.example.com";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, data: null }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/session");

    expect(cookiesMock).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://public.example.com/api/session");
    expect(init.credentials).toBe("include");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("cookie")).toBeNull();
  });

  it("throws a clear error when NEXT_PUBLIC_BACKEND_URL is missing", async () => {
    delete process.env.NEXT_PUBLIC_BACKEND_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/session")).rejects.toThrow(
      /NEXT_PUBLIC_BACKEND_URL/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// T-18: HTTP-клиент фронта/RSC на BACKEND_URL (PG-IMPL-SPEC §4.3, §3.5, ОВ-4).
//
// Единая точка вызова HTTP-API `app/api/*`. Работает и на сервере (RSC / route
// handler / SSR), и в браузере — ветки разделены по `typeof window`:
//
//   • Сервер: база из BACKEND_URL; входящие cookie тянутся из next/headers и
//     прокидываются в заголовок Cookie (прод same-origin → сессия видна; фронт-дев
//     против прод-API → деградирует до анонимного запроса, §3.5).
//   • Браузер: база из NEXT_PUBLIC_BACKEND_URL (единственное, что уходит в бандл);
//     cookie отправляет сам браузер через credentials:"include" (кросс-origin).
//
// `next/headers` импортируется ДИНАМИЧЕСКИ и только в серверной ветке, чтобы
// серверный модуль не попал в браузерный бандл.
//
// Тело ответа парсится как JSON и возвращается как T. Ответы `app/api/*` имеют
// форму ActionResult<T> (src/server/actions/types.ts), но apiFetch намеренно
// отдаёт сырой JSON — дискриминацию `ok` делает вызывающий на месте (тонкие
// типизированные обёртки появятся вместе с потребителями).

const isServer = () => typeof window === "undefined";

/** База API по среде; бросает понятную ошибку при отсутствии настройки. */
function resolveBaseUrl(): string {
  const server = isServer();
  const base = server
    ? process.env.BACKEND_URL
    : process.env.NEXT_PUBLIC_BACKEND_URL;

  if (!base) {
    throw new Error(
      server
        ? "apiFetch: BACKEND_URL is not set (server-side API base URL)"
        : "apiFetch: NEXT_PUBLIC_BACKEND_URL is not set (browser API base URL)",
    );
  }
  return base.replace(/\/+$/, "");
}

/**
 * Входящая cookie текущего запроса (RSC/route/SSR). Динамический импорт держит
 * `next/headers` вне браузерного бандла — вызывается только на сервере.
 */
async function incomingCookieHeader(): Promise<string> {
  const { cookies } = await import("next/headers");
  return (await cookies()).toString();
}

/** Абсолютный или ведущий-slash путь → нормализуем к `/path`. */
function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Запрос к HTTP-API на BACKEND_URL. Возвращает распарсенный JSON как T.
 * Не бросает на не-2xx (route handlers отдают ActionResult с телом и статусом —
 * тело всё равно читаем); бросает при отсутствии базового URL или нечитаемом теле.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);

  if (isServer()) {
    const cookie = await incomingCookieHeader();
    if (cookie) headers.set("cookie", cookie);
  }

  const res = await fetch(resolveBaseUrl() + normalizePath(path), {
    ...init,
    headers,
    credentials: "include",
    cache: "no-store",
  });

  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(
      `apiFetch: expected JSON from ${normalizePath(path)} (status ${res.status})`,
    );
  }
}

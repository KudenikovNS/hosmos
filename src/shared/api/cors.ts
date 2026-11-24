// T-18: CORS-helper для кросс-origin route handlers (PG-IMPL-SPEC §3.5, ОВ-4).
//
// Нужен только для dev-сценария «фронт-дев (localhost) → прод-API» (§3.5): без
// CORS браузер не отдаст ответ кросс-origin запросу с credentials. В проде фронт
// и API same-origin (BACKEND_URL=self) — CORS не требуется, и helper здесь —
// no-op (не трогает ответ, ничего не ломает).
//
// Каверзы, зафиксированные спекой:
//   • при credentials НЕЛЬЗЯ `Access-Control-Allow-Origin: *` — ставим КОНКРЕТНЫЙ
//     origin, и только если он в allowlist (ALLOWED_ORIGINS);
//   • нужен `Access-Control-Allow-Credentials: true` и `Vary: Origin` (кэш);
//   • allowlist — из env, чужие домены не хардкодятся.

const ALLOWED_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization";
const MAX_AGE = "86400";

/** Allowlist origin'ов из ALLOWED_ORIGINS (CSV). Читается при вызове. */
function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Разрешён ли origin к кросс-origin доступу (точное совпадение с allowlist). */
export function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins().includes(origin);
}

/**
 * Проставляет CORS-заголовки на ответ, ЕСЛИ origin известен и в allowlist.
 * Иначе — возвращает ответ нетронутым (same-origin/прод не ломается).
 * Дженерик сохраняет подтип (NextResponse и т.п.).
 */
export function withCors<R extends Response>(
  response: R,
  origin?: string | null,
): R {
  if (origin && isAllowedOrigin(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.append("Vary", "Origin");
  }
  return response;
}

/**
 * Ответ на OPTIONS-preflight: 204 + Allow-Methods/Allow-Headers/Max-Age, плюс
 * CORS-заголовки для allowed origin (через withCors). Для неразрешённого origin
 * тоже 204, но без Allow-Origin — браузер сам заблокирует.
 */
export function corsPreflightResponse(origin?: string | null): Response {
  const res = new Response(null, { status: 204 });
  res.headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  res.headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  res.headers.set("Access-Control-Max-Age", MAX_AGE);
  return withCors(res, origin);
}

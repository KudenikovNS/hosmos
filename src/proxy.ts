import createMiddleware from "next-intl/middleware";
import { isPublicPath } from "@/shared/routes";
import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/i18n/routing";

const intlMiddleware = createMiddleware(routing);

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // 1) next-intl: resolve the locale and, when needed, redirect to add/remove
  // the `/sl` prefix. If it produced a redirect, return it immediately.
  const response = intlMiddleware(request);
  if (response.headers.has("location")) {
    return response;
  }

  // 2) Fast route guard: derive "is authenticated" from the presence of the
  // better-auth session cookie WITHOUT a database round-trip (the approach
  // better-auth recommends for Next.js middleware). Authoritative validation
  // happens later in the route handlers / `getSession()`; here we only gate
  // navigation. A missing cookie is treated as unauthenticated.
  const isAuthenticated = getSessionCookie(request) !== null;

  // `sl` is the prefixed locale; `en` (default) has no prefix. Strip the
  // prefix to match public paths, and keep it so redirects preserve the locale.
  // Any non-default locale is prefixed (`/sl/…`, `/ru/…`); strip it so the
  // public-path and redirect logic below reasons about the bare route.
  const prefixed = routing.locales.find(
    (locale) =>
      locale !== routing.defaultLocale &&
      (pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)),
  );
  const prefix = prefixed ? `/${prefixed}` : "";
  const bare = prefixed ? pathname.slice(prefix.length) || "/" : pathname;

  // Public routes that don't require authentication — the same list analytics
  // is limited to (партия 20), so «the site» has one definition.
  const isPublic = isPublicPath(bare);

  // Protected routes — redirect to login (keeping the locale) if not authed.
  if (!isAuthenticated && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = `${prefix}/login`;
    return NextResponse.redirect(url);
  }

  // Redirect logged-in users away from the auth pages, keeping the locale.
  if (
    isAuthenticated &&
    (bare.startsWith("/login") || bare.startsWith("/register"))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = `${prefix}/readiness`;
    return NextResponse.redirect(url);
  }

  // Return the intl middleware's response so its locale cookie/headers survive.
  return response;
}

export const config = {
  // Exclude /api/* entirely: route handlers are self-guarding (they return a
  // 401/JSON via `getSession()`), so the proxy must NOT redirect them to
  // /login — that would both mask API errors as HTML redirects and, fatally,
  // block /api/auth/* so no one could ever sign in. The proxy only gates page
  // navigation.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

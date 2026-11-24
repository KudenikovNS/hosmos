import createNextIntlPlugin from "next-intl/plugin";

import { pdfmakeTraceIncludes } from "./scripts/pdfmake-runtime.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Сборка self-contained Node-сервера для контейнера: .next/standalone/server.js
  output: "standalone",
  images: { unoptimized: true },
  // Аудит 16.08.2026, п. 5: на проде не было ни одного security-заголовка, а
  // `x-powered-by: Next.js` был. Реальный вектор — кликджекинг на `/review`:
  // страница в невидимом iframe, залогиненный аппрувер нажимает Approve/Lock и
  // подписывает отчёт. `frame-ancestors 'none'` + `X-Frame-Options: DENY`
  // закрывают ровно это. HSTS — чтобы первый http-запрос не перехватывался.
  // Полный CSP со скриптами не вводится здесь: next-intl и Recharts инлайнят
  // стили и скрипты, а ломать рендер ради заголовка — не задача этого шага.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },

  // R-9 — СЕРВЕРНЫЙ РЕНДЕР PDF (T5.6). Три строки, и каждая обязательна:
  //
  //  • `serverExternalPackages` — pdfmake НЕ бандлится. Под ним
  //    `@foliojs-fork/pdfkit` читает `.afm`/`.trie`/`.icc` с диска через
  //    `fs.readFileSync`; бандлер втянет JS и оставит данные, а падение вылезет
  //    только в момент рендера на проде.
  //  • `outputFileTracingIncludes` — pdfmake физически кладётся в
  //    `.next/standalone`. Трейсер Next уже однажды выбросил нужный пакет
  //    (`deploy.yml` вручную докладывает `drizzle-orm` и `postgres`), и чистая
  //    сборка этого репозитория даёт `standalone/node_modules` из девяти
  //    пакетов — pdfmake среди них нет. Список считается из реального дерева
  //    зависимостей: `scripts/pdfmake-runtime.mjs`.
  //    Мёртвый вес (13 из 14 МБ pdfmake — браузерный бандл `build/`, от которого
  //    серверный рендер как раз и ушёл; source maps) вычитается ВНУТРИ списка
  //    includes, а не через `outputFileTracingExcludes`: измерено, что excludes
  //    против явного include не выигрывает (R-3, дисковая квота).
  //
  // Проверяется на прод-бандле: `node scripts/check-standalone-render.mjs`.
  serverExternalPackages: ["pdfmake"],
  outputFileTracingIncludes: { "/**": pdfmakeTraceIncludes() },
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);

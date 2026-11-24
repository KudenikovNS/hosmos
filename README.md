# Hosmos

B2B SaaS для словенских SME: VSME-отчётность, расчёт Scope 1 / Scope 2 с
проверяемыми коэффициентами, доказательная база и неизменяемые версии отчётов.
Next.js 16 (App Router, standalone), PostgreSQL + Drizzle, better-auth, next-intl
(интерфейс: `en`, `sl`, `ru`, `de`, `it`, `sr`, `hr`; отчёт: `en`, `sl`), CSS
Modules без Tailwind.

## С чего начать

| Вопрос                                                      | Где ответ                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| Как устроен продукт, путь пользователя, куда идём           | `docs/project-map.md`                                     |
| Что делаем в этом этапе и что вне его                       | `docs/plan-2026-09.md`, `docs/roadmap-2026-09.md`         |
| Как устроена модель данных и почему                         | `docs/design/data-model/01`–`06` (решения D1–D24)         |
| Как данные текут от ввода к отчёту                          | `docs/data-flow-reference.md` (`.ru.md` — русская версия) |
| Миграции, справочные данные, `DOCUMENTS_DIR`, крон биллинга | `drizzle/README.md`                                       |
| Токены, брейкпоинты, компоненты, чек-лист перед мерджем     | `docs/design-system.md`                                   |
| Наработки ESG-эксперта (метрики VSME, коэффициенты, тарифы) | `docs/expert-aleksandra/`                                 |
| Что нужно клиенту по Scope 3 и почему пока не считаем       | `docs/design/scope3-data-requirements.md`                 |
| История изменений                                           | `git log`                                                 |

## Локальная разработка

```bash
cp .env.example .env          # заполнить DATABASE_URL, BETTER_AUTH_SECRET, …
docker compose up -d          # PostgreSQL 13 — та же мажорная версия, что на проде
npm install
npm run db:migrate            # все миграции drizzle/
npm run db:seed               # справочники + локальные фикстуры (только off-server)
npm run dev
```

Демо-данные для витрины: `node scripts/demo-seed.mjs` (см. шапку скрипта).

## Проверки перед мерджем

```bash
./node_modules/.bin/tsc --noEmit --incremental false
npm run lint
npm run format:check
scripts/review-db.sh run -- npm test   # только одноразовая БД: тесты делают TRUNCATE (см. AGENTS.md)
npm run build && npm run check:standalone
```

Хук `husky` гоняет `eslint --fix` и `prettier` на staged-файлах.

## Прод

Shared-хостинг neoserv.si (cPanel, Passenger). Артефакт — `.next/standalone`;
деплой описан в `.github/workflows/deploy.yml`. PostgreSQL на проде — **13.23**
(общий кластер, версия не выбирается); поэтому CI и docker-compose закреплены
на `postgres:13`, а конструкции PG 14+ в миграциях запрещены. Миграции на проде
накатываются автоматически при каждом деплое: шаг «Migrate DB» в `deploy.yml`
запускает на сервере `node scripts/migrate.mjs` до перезапуска приложения
(накатывает только непринятые, идемпотентно). Сиды на проде не запускаются —
справочники приходят миграциями; см. `drizzle/README.md`.

### Перед включением боевых платежей Revolut

На стадии MVP две находки ревью по оплате отложены (решение владельца от
20.11.2026). Их нужно закрыть **до**
включения боевых ключей Revolut — подробности и выбранные решения в
`docs/reviews/2026-11-06_18-42-16_project.md`:

- **F10 `workflow-missing-revolut-mode`** — браузер берёт режим виджета из
  `NEXT_PUBLIC_REVOLUT_MODE`, которую деплой не передаёт, и молча открывает
  `sandbox`. С боевым заказом оплата не откроется. Исправить до смены
  `REVOLUT_API_BASE` на боевой.
- **F07 `mit-charge-pending-marked-completed`** — списание с сохранённой карты
  считается оплатой до подтверждения Revolut. Исправить до включения апгрейда с
  сохранённой картой или до первого автопродления, что раньше.

## Справочные данные

- `metric_catalog` — 191 показатель: 141 VSME (генерирует
  `scripts/gen-vsme-metrics.mjs`) и 50 показателей упрощённого ESRS
  (`scripts/gen-esrs-catalogue.mjs`, `drizzle/0019`); исходники — воркбуки
  эксперта в gitignored `workbook/`. Словенские названия — `drizzle/0017`, `0018`.
  Тексты, которые видит пользователь (названия, подсказки, инструкции
  стандарта на всех языках интерфейса), — в `src/server/catalog/texts/`.
- `factor_set` — ревизии словенского набора `si-2025` … `si-2025-r5`
  (`drizzle/0009`, `0015`, `0020`, `0023`, `0024`), источники ARSO/AGEN/AIB + IPCC.
- `unit_conversion`, `fx_rates` — `drizzle/0010`, `0012`.

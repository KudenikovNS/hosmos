# syntax=docker/dockerfile:1
# Multi-stage build для Next.js 14 (output: 'standalone').
# Итоговый образ ~150 МБ, запускает node server.js без dev-зависимостей.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# package-lock сгенерирован npm 11; node:22-slim несёт npm 10.9.8, который падает
# на нём ("Invalid Version" в optional-платформенных зависимостях sharp/@img).
# Выравниваем npm до 11 перед ci — как это делает и neoserv-workflow.
RUN npm install -g npm@11 && npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Runtime env (DATABASE_URL, BETTER_AUTH_*, SMTP, BACKEND_URL) живёт в среде
# приложения (cPanel Node.js-selector / compose), НЕ в build. В клиентский бандл
# инлайнится только NEXT_PUBLIC_BACKEND_URL. Миграции в build НЕ гоняются —
# на build нет БД (baseline применяется отдельным ручным шагом, см. .env.example).
ENV NEXT_TELEMETRY_DISABLED=1

# Quality-gate: линт и тесты валят сборку до дорогого next build. DATABASE_URL
# здесь намеренно НЕ задан → интеграционные тесты self-skip'ают (harness пингует
# БД), прогоняются engine+unit. Интеграция гоняется в dev/CI с docker-compose.
RUN npm run lint && npm test

RUN npm run build
# В репо может не быть public/ — гарантируем папку, чтобы COPY ниже не падал.
RUN mkdir -p public

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# standalone уже содержит минимальный node_modules + server.js
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]

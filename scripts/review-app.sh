#!/usr/bin/env bash
# Изолированный dev-сервер Hosmos для браузерных проверок ревью.
#
# Изолировать только базу недостаточно: `next dev` сам читает `.env*` и
# подхватил бы настоящие SMTP (письма тестовым адресам ушли бы по-настоящему),
# Revolut и DOCUMENTS_DIR. Поэтому сервер запускается:
#   - из временной копии исходников БЕЗ `.env*`, `.git`, `creds.md`, `*.pem`;
#   - с node_modules, склонированными copy-on-write (APFS `cp -c`, reflink на
#     Linux) — симлинк Turbopack не принимает;
#   - с пустым окружением (`env -i`) и явным списком тестовых значений: без SMTP
#     mailer пропускает письма, без ключей Revolut оплата недоступна;
#   - с временным DOCUMENTS_DIR;
#   - только на базе, созданной scripts/review-db.sh (проверяется метка).
#
# Запуск — всегда внутри review-db.sh, чтобы база тоже была одноразовой:
#
#   scripts/review-db.sh run -- scripts/review-app.sh 3147
#
# Сервер слушает http://localhost:<port> (по умолчанию 3147, не порт вашего
# dev-сервера). База мигрируется продовым путём и заполняется dev-фикстурами.
# При остановке (Ctrl-C, kill) копия и хранилище удаляются, базу удаляет
# review-db.sh.
set -euo pipefail

PORT="${1:-3147}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

die() {
  echo "review-app: $*" >&2
  exit 1
}

[ -n "${DATABASE_URL:-}" ] && [ -n "${REVIEW_DB_NAME:-}" ] ||
  die "запускайте через: scripts/review-db.sh run -- $0 [port]"
[ "$(docker inspect -f '{{ index .Config.Labels "purpose" }}' "$REVIEW_DB_NAME" 2>/dev/null)" = "hosmos-review" ] ||
  die "$REVIEW_DB_NAME не одноразовая база ревью — отказ"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "порт $PORT занят"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hosmos-review-app.XXXXXX")"
child=""
# Next запускает воркеры дочерними процессами: сигнал одному CLI оставил бы
# сервер висеть на порту. Поэтому next dev стартует в своей группе процессов
# (set -m ниже), и останавливается вся группа. Под set +e: иначе ненулевой
# код `wait` оборвал бы очистку до удаления копии.
cleanup() {
  set +e
  if [ -n "$child" ]; then
    kill -TERM -- "-$child" 2>/dev/null
    for _ in $(seq 1 10); do
      kill -0 -- "-$child" 2>/dev/null || break
      sleep 1
    done
    kill -KILL -- "-$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 143' INT TERM

echo "review-app: копия исходников в $WORK" >&2
rsync -a \
  --exclude '/.git' --exclude '/node_modules' --exclude '/.next' \
  --exclude '.env' --exclude '.env.*' --exclude 'creds.md' --exclude '*.pem' \
  --exclude '/workbook' --exclude '/.codex' --exclude '/.aws' \
  "$ROOT/" "$WORK/app/"
if [ "$(uname)" = "Darwin" ]; then
  cp -cR "$ROOT/node_modules" "$WORK/app/node_modules"
else
  cp -a --reflink=auto "$ROOT/node_modules" "$WORK/app/node_modules"
fi
mkdir -p "$WORK/documents"

ORIGIN="http://localhost:$PORT"
run_isolated() {
  env -i \
    PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL="$DATABASE_URL" \
    BETTER_AUTH_SECRET="review-$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')" \
    BETTER_AUTH_URL="$ORIGIN" \
    BACKEND_URL="$ORIGIN" \
    NEXT_PUBLIC_BACKEND_URL="$ORIGIN" \
    TRUSTED_ORIGINS="$ORIGIN" \
    ALLOWED_ORIGINS="$ORIGIN" \
    REQUIRE_EMAIL_VERIFICATION=false \
    DOCUMENTS_DIR="$WORK/documents" \
    "$@"
}

cd "$WORK/app"
[ -z "$(find . -maxdepth 1 -name '.env*' -print -quit)" ] || die "в копии остался .env-файл"
run_isolated node scripts/migrate.mjs
run_isolated ./node_modules/.bin/tsx src/server/db/seed.ts

echo "review-app: $ORIGIN (база $REVIEW_DB_NAME)" >&2
set -m # фоновое задание получает собственную группу процессов (pgid = pid)
run_isolated ./node_modules/.bin/next dev --port "$PORT" --hostname localhost &
child=$!
set +m
wait "$child"

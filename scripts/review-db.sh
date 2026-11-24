#!/usr/bin/env bash
# Одноразовая PostgreSQL 13 для ревью и DB-тестов.
#
# Интеграционный harness (`src/server/db/__tests__/harness.ts`) делает
# TRUNCATE ... CASCADE, поэтому DB-тесты нельзя направлять на dev-базу из
# docker-compose. Каждый запуск получает НОВЫЙ контейнер с уникальным именем:
#   - образ postgres:13 (= прод neoserv, 13.23);
#   - PGDATA в tmpfs, без volumes — после удаления ничего не остаётся;
#   - случайный порт, привязанный только к 127.0.0.1;
#   - метка purpose=hosmos-review — скрипт удаляет только контейнеры с ней.
# Контейнеры никогда не переиспользуются: два параллельных ревью не делят базу,
# а проверка миграций всегда видит чистую установку, а не базу после сидов.
#
# Основной режим — run: поднять базу, выполнить команду, удалить базу (в том
# числе при ошибке или прерывании). Команда получает DATABASE_URL и
# REVIEW_DB_NAME в окружении:
#
#   scripts/review-db.sh run -- npm test
#   scripts/review-db.sh run -- sh -c 'node scripts/migrate.mjs && node scripts/migrate.mjs'
#
# Для долгих сессий в нескольких вызовах shell (браузерная проверка и т. п.):
#
#   scripts/review-db.sh up          # печатает export REVIEW_DB_NAME=… и DATABASE_URL=…
#   scripts/review-db.sh url NAME
#   scripts/review-db.sh down NAME   # имя обязательно: чужой контейнер не удалить
#   scripts/review-db.sh list        # все контейнеры ревью, включая забытые
set -euo pipefail

LABEL_KEY="purpose"
LABEL_VALUE="hosmos-review"
IMAGE="postgres:13"
DB_USER="review"
DB_PASS="review"
DB_NAME="hosmos_review"

die() {
  echo "review-db: $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || die "docker не найден"

new_name() {
  echo "hosmos-review-$(date +%Y%m%d-%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
}

is_ours() {
  [ "$(docker inspect -f "{{ index .Config.Labels \"$LABEL_KEY\" }}" "$1" 2>/dev/null)" = "$LABEL_VALUE" ]
}

url_of() {
  local port
  port="$(docker port "$1" 5432/tcp 2>/dev/null | head -n1 | sed 's/.*://')"
  [ -n "$port" ] || die "контейнер $1 не запущен"
  echo "postgres://${DB_USER}:${DB_PASS}@127.0.0.1:${port}/${DB_NAME}"
}

start() {
  local name="$1"
  docker run -d --rm \
    --name "$name" \
    --label "$LABEL_KEY=$LABEL_VALUE" \
    --tmpfs /var/lib/postgresql/data:rw \
    -e POSTGRES_USER="$DB_USER" \
    -e POSTGRES_PASSWORD="$DB_PASS" \
    -e POSTGRES_DB="$DB_NAME" \
    -p 127.0.0.1::5432 \
    "$IMAGE" >/dev/null
  # Postgres перезапускается один раз при инициализации кластера, поэтому
  # ждём не первого ответа pg_isready, а успешного запроса через TCP.
  for _ in $(seq 1 60); do
    if docker exec "$name" psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -c 'select 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  remove "$name"
  die "контейнер $name не стал доступен за 60 с"
}

remove() {
  local name="$1"
  docker inspect "$name" >/dev/null 2>&1 || return 0
  is_ours "$name" || die "контейнер $name без метки $LABEL_KEY=$LABEL_VALUE — не удаляю"
  docker rm -f "$name" >/dev/null
}

RUN_NAME=""
RUN_CHILD=""

on_signal() {
  set +e
  if [ -n "$RUN_CHILD" ]; then
    kill -TERM "$RUN_CHILD" 2>/dev/null
    wait "$RUN_CHILD" 2>/dev/null
  fi
  exit 143
}

cmd_run() {
  [ "${1:-}" = "--" ] && shift
  [ $# -gt 0 ] || die "использование: $0 run -- <команда>"

  RUN_NAME="$(new_name)"
  local name="$RUN_NAME"
  # Очистка при любом выходе: успех, ошибка команды, Ctrl-C, kill.
  trap 'remove "$RUN_NAME"' EXIT
  # Команда запускается в фоне и ждётся через wait, чтобы сигнал дошёл до неё,
  # а не ждал её завершения (bash откладывает trap, пока идёт foreground-процесс).
  trap on_signal INT TERM

  start "$name"
  echo "review-db: $name готова" >&2

  set +e
  REVIEW_DB_NAME="$name" DATABASE_URL="$(url_of "$name")" "$@" &
  RUN_CHILD=$!
  wait "$RUN_CHILD"
  local rc=$?
  set -e
  exit "$rc"
}

cmd_up() {
  local name
  name="$(new_name)"
  start "$name"
  echo "export REVIEW_DB_NAME=$name"
  echo "export DATABASE_URL=$(url_of "$name")"
}

cmd_list() {
  docker ps --filter "label=$LABEL_KEY=$LABEL_VALUE" \
    --format '{{.Names}}\t{{.RunningFor}}\t{{.Ports}}'
}

case "${1:-}" in
  run)
    shift
    cmd_run "$@"
    ;;
  up) cmd_up ;;
  url)
    [ -n "${2:-}" ] || die "использование: $0 url <имя>"
    url_of "$2"
    ;;
  down)
    [ -n "${2:-}" ] || die "использование: $0 down <имя> (список: $0 list)"
    remove "$2"
    ;;
  list) cmd_list ;;
  *) die "использование: $0 run -- <команда> | up | url <имя> | down <имя> | list" ;;
esac

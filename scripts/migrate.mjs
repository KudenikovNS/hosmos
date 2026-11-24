// Автомиграция на деплое (бежит на СЕРВЕРЕ neoserv по SSH — prod-Postgres там на
// localhost под владельцем helphub_helphub из DATABASE_URL; снаружи БД недоступна).
//
// «По феншую»: сам накат делает ШТАТНЫЙ drizzle-мигратор
// (`drizzle-orm/postgres-js/migrator`), ведущий `drizzle.__drizzle_migrations` как
// flyway_schema_history и накатывающий только непринятое, идемпотентно.
//
// Единственная custom-часть — ОДНОРАЗОВЫЙ baseline (усыновление существующей prod-БД,
// §решение «baseline без сброса»): у прод-БД схема частично есть, а служебной таблицы
// нет (накатывали импортом, не drizzle-kit). Голый migrate() попытался бы накатить
// 0000 с нуля и упал бы на существующих таблицах — baseline-команды у drizzle нет.
// Поэтому: если журнал пуст, определяем по НАЛИЧИЮ таблиц, до какой миграции БД уже
// доведена (companies→0000, plans→0001, audit_log→0002), и вписываем для них КАНОНИЧЕСКИЕ
// строки. Канон проверен: drizzle пишет hash=sha256(файла), created_at=journal.when —
// наши sha256 совпали со всеми хэшами drizzle-kit (см. историю). После первого прогона
// журнал заполнен — baseline больше не срабатывает, дальше чистый migrate().
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("migrate: DATABASE_URL is not set");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const FOLDER = process.env.MIGRATIONS_FOLDER || join(here, "..", "drizzle");

// Таблица-«доказательство», что миграция с этим idx уже накатана. Порядок = journal.
const BASELINE_PROBE = ["companies", "plans", "audit_log"]; // 0000, 0001, 0002

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

/**
 * ОДНОРАЗОВЫЙ baseline: если __drizzle_migrations пуста, а схема уже частично есть —
 * вписать КАНОНИЧЕСКИЕ строки для уже-накатанных миграций, чтобы штатный migrate()
 * их пропустил. Строки идентичны тем, что записал бы сам drizzle (проверено).
 */
async function baselineIfNeeded() {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "drizzle";`);
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
       id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);`,
  );
  const [{ count }] = await sql`
    select count(*)::int as count from "drizzle"."__drizzle_migrations"`;
  if (count > 0) return; // уже под контролем drizzle — baseline не нужен

  const journal = JSON.parse(
    readFileSync(join(FOLDER, "meta", "_journal.json"), "utf8"),
  );
  const entries = journal.entries.slice().sort((a, b) => a.idx - b.idx);

  let through = -1;
  for (let i = 0; i < BASELINE_PROBE.length && i < entries.length; i++) {
    const [{ present }] = await sql`
      select (to_regclass(${"public." + BASELINE_PROBE[i]}) is not null) as present`;
    if (present) through = i;
    else break; // миграции строго по порядку: разрыв — дальше не накатано
  }
  if (through < 0) {
    console.log(
      "migrate: пустая БД — baseline не нужен, migrate() накатит всё.",
    );
    return;
  }
  for (let i = 0; i <= through; i++) {
    const query = readFileSync(join(FOLDER, `${entries[i].tag}.sql`), "utf8");
    const hash = createHash("sha256").update(query).digest("hex");
    await sql`insert into "drizzle"."__drizzle_migrations" ("hash","created_at")
              values (${hash}, ${Number(entries[i].when)})`;
  }
  console.log(
    `migrate: baseline — отмечено применёнными ${through + 1} миграций (до ${entries[through].tag}).`,
  );
}

async function main() {
  await baselineIfNeeded();
  // Штатный drizzle-мигратор: накатывает только непринятое, ведёт журнал сам.
  await migrate(drizzle(sql), { migrationsFolder: FOLDER });
  console.log(
    "migrate: готово (штатный drizzle-мигратор, непринятое накатано).",
  );
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("migrate: ОШИБКА —", e?.message ?? e);
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });

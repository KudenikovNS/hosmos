#!/usr/bin/env node
// Актуальный статус находок ревью по всей истории docs/reviews/*.findings.json.
//
// Отчёты бывают разного охвата (project, frontend, infra, diff, recheck), поэтому
// «последний файл» не равен «текущему состоянию»: после полного аудита и
// аудита фронтенда последним окажется фронтендовый отчёт, и серверные находки
// выпали бы из перепроверки. Здесь статус каждой находки берётся из САМОГО
// ПОЗДНЕГО отчёта, где встречается её slug; отчёты сортируются по имени
// (оно начинается с даты и времени).
//
//   node scripts/review-findings.mjs            # открытые: open + regressed
//   node scripts/review-findings.mjs --all      # все slug'и с последним статусом
//   node scripts/review-findings.mjs --json     # то же в JSON (для recheck)
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "reviews",
);
const args = new Set(process.argv.slice(2));
const OPEN = new Set(["open", "regressed"]);

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".findings.json"))
  .sort();

const latest = new Map();
for (const file of files) {
  const report = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  for (const finding of report.findings ?? []) {
    if (!finding.slug) {
      console.error(
        `${file}: находка без slug пропущена (${finding.id ?? "?"})`,
      );
      continue;
    }
    const history = latest.get(finding.slug)?.history ?? [];
    history.push(`${report.review ?? file}:${finding.status}`);
    latest.set(finding.slug, { ...finding, source: file, history });
  }
}

const rows = [...latest.values()]
  .filter((f) => args.has("--all") || OPEN.has(f.status))
  .sort((a, b) => (a.priority ?? "P9").localeCompare(b.priority ?? "P9"));

if (args.has("--json")) {
  console.log(JSON.stringify({ sources: files, findings: rows }, null, 2));
} else if (rows.length === 0) {
  console.log(`Открытых находок нет (отчётов: ${files.length}).`);
} else {
  for (const f of rows) {
    const test = f.test ? "test" : "no-test";
    console.log(
      `${f.priority}\t${f.status}\t${f.area}\t${f.slug}\t${test}\t← ${f.source}`,
    );
  }
}

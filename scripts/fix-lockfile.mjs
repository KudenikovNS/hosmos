// Чинит известный баг генерации package-lock.json с пакетами sharp:
// некоторые опциональные записи (например @img/sharp-libvips-linuxmusl-x64)
// оказываются без поля "version", из-за чего `npm ci` на Linux падает с
// "Invalid Version:". Эти записи — под чужую платформу (musl) и на glibc-сервере
// не ставятся, поэтому достаточно проставить им корректную версию, чтобы npm
// смог распарсить lock-файл. Запускается в CI перед `npm ci`.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "package-lock.json";
const lock = JSON.parse(readFileSync(FILE, "utf8"));
const pkgs = lock.packages || {};

const nameOf = (p) => p.split("node_modules/").pop();

let fixed = 0;
for (const [path, entry] of Object.entries(pkgs)) {
  if (path === "" || entry.link || entry.version) continue;

  const name = nameOf(path);
  let version = null;

  // 1) версия из optionalDependencies родителя, который ссылается на этот пакет
  for (const parent of Object.values(pkgs)) {
    const spec =
      parent.optionalDependencies?.[name] || parent.dependencies?.[name];
    if (spec) {
      const m = String(spec).match(/\d+\.\d+\.\d+[^\s]*/);
      if (m) {
        version = m[0];
        break;
      }
    }
  }
  // 2) запасной вариант — версия одноимённого пакета в другом месте дерева
  if (!version) {
    for (const [p2, e2] of Object.entries(pkgs)) {
      if (p2 !== path && e2.version && nameOf(p2) === name) {
        version = e2.version;
        break;
      }
    }
  }

  if (version) {
    entry.version = version;
    fixed++;
    console.log(`  fixed: ${path} -> ${version}`);
  } else {
    console.warn(`  WARN: не удалось определить версию для ${path}`);
  }
}

if (fixed > 0) {
  writeFileSync(FILE, JSON.stringify(lock, null, 2) + "\n");
}
console.log(`fix-lockfile: исправлено записей: ${fixed}`);

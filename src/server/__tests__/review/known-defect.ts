/**
 * Подтверждённый ревью дефект, закреплённый тестом ОЖИДАЕМОГО поведения.
 *
 * Зачем не `it.fails`: он зеленеет на ЛЮБОЙ ошибке, в том числе на сломанной
 * фикстуре или опечатке, и тогда «дефект жив» нельзя отличить от «тест больше
 * ничего не проверяет». Здесь тест разделён на две фазы:
 *
 *   1. `arrange()` строит состояние и возвращает проверку правильного поведения.
 *      Любая ошибка в этой фазе — настоящий провал теста.
 *   2. Проверка бросает `AssertionError` → дефект ещё воспроизводится → тест
 *      зелёный. Любая другая ошибка (TypeError и т. п.) пробрасывается.
 *      Проверка проходит → дефект исправлен → тест ПАДАЕТ с подсказкой
 *      переименовать `knownDefect` в `regressionTest`.
 *
 * `regressionTest` принимает ту же `arrange` и просто выполняет возвращённую
 * проверку. Конвертация — замена одного слова; заменять на `it` НЕЛЬЗЯ: `it`
 * не вызывает функцию, которую возвращает `arrange`, и тест станет пустым.
 */
import { it } from "vitest";

type AssertFixed = () => unknown;
type Arrange = () => Promise<AssertFixed>;

function isAssertionError(error: unknown): boolean {
  return error instanceof Error && error.name === "AssertionError";
}

/** Тело `knownDefect` — экспортировано для самопроверки хелпера. */
export async function runKnownDefect(
  id: string,
  arrange: Arrange,
): Promise<void> {
  const assertFixed = await arrange();
  try {
    await assertFixed();
  } catch (error) {
    if (isAssertionError(error)) return;
    throw error;
  }
  throw new Error(
    `${id} больше не воспроизводится: ожидаемое поведение выполнено. ` +
      `Замените knownDefect(...) на regressionTest(...) — с теми же аргументами.`,
  );
}

/** Тело `regressionTest` — экспортировано для самопроверки хелпера. */
export async function runRegression(arrange: Arrange): Promise<void> {
  const assertFixed = await arrange();
  await assertFixed();
}

export function knownDefect(id: string, title: string, arrange: Arrange): void {
  it(`[known defect ${id}] ${title}`, () => runKnownDefect(id, arrange));
}

/** Исправленный дефект: та же `arrange`, проверка обязана пройти. */
export function regressionTest(
  id: string,
  title: string,
  arrange: Arrange,
): void {
  it(`[regression ${id}] ${title}`, () => runRegression(arrange));
}

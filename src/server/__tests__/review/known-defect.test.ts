// Самопроверка хелпера: ошибка в `knownDefect`/`regressionTest` незаметно
// превратила бы все тесты известных дефектов в пустышки.
import { describe, expect, it } from "vitest";

import { runKnownDefect, runRegression } from "./known-defect";

const defectAlive = async () => () => expect(1).toBe(2);
const defectFixed = async () => () => expect(1).toBe(1);
const brokenFixture = async (): Promise<() => unknown> => {
  throw new Error("fixture");
};
const brokenCheck = async () => () => {
  throw new TypeError("not an assertion");
};

describe("knownDefect", () => {
  it("зелёный, пока дефект воспроизводится", async () => {
    await expect(runKnownDefect("x", defectAlive)).resolves.toBeUndefined();
  });
  it("падает, когда дефект исправлен, и подсказывает regressionTest", async () => {
    await expect(runKnownDefect("x", defectFixed)).rejects.toThrow(
      /regressionTest/,
    );
  });
  it("падает на сломанной фикстуре", async () => {
    await expect(runKnownDefect("x", brokenFixture)).rejects.toThrow("fixture");
  });
  it("падает на ошибке проверки, которая не является AssertionError", async () => {
    await expect(runKnownDefect("x", brokenCheck)).rejects.toThrow(TypeError);
  });
});

describe("regressionTest", () => {
  it("выполняет возвращённую проверку", async () => {
    await expect(runRegression(defectFixed)).resolves.toBeUndefined();
    await expect(runRegression(defectAlive)).rejects.toThrow();
  });
});

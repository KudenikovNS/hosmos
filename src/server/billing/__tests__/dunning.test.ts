// Unit tests for the PURE dunning schedule helper (T-D1). No DB, no network — reads
// only `process.env.DUNNING_INTERVAL_DAYS`, which each test sets/clears.
import { afterEach, describe, expect, it } from "vitest";

import { dunningRetries, intervalDays } from "../dunning";

const saved = process.env.DUNNING_INTERVAL_DAYS;
const savedRetries = process.env.DUNNING_RETRIES;
afterEach(() => {
  if (saved === undefined) delete process.env.DUNNING_INTERVAL_DAYS;
  else process.env.DUNNING_INTERVAL_DAYS = saved;
  if (savedRetries === undefined) delete process.env.DUNNING_RETRIES;
  else process.env.DUNNING_RETRIES = savedRetries;
});

describe("intervalDays", () => {
  it("indexes a CSV schedule 1-based (attempt 1 → first element)", () => {
    process.env.DUNNING_INTERVAL_DAYS = "1,3,5";
    expect(intervalDays(1)).toBe(1);
    expect(intervalDays(2)).toBe(3);
    expect(intervalDays(3)).toBe(5);
  });

  it("clamps attempts past the schedule to the last element", () => {
    process.env.DUNNING_INTERVAL_DAYS = "1,3,5";
    expect(intervalDays(4)).toBe(5);
    expect(intervalDays(99)).toBe(5);
  });

  it("applies a single number to every attempt", () => {
    process.env.DUNNING_INTERVAL_DAYS = "7";
    expect(intervalDays(1)).toBe(7);
    expect(intervalDays(2)).toBe(7);
    expect(intervalDays(10)).toBe(7);
  });

  it("falls back to 1 day when unset", () => {
    delete process.env.DUNNING_INTERVAL_DAYS;
    expect(intervalDays(1)).toBe(1);
  });

  it("falls back to 1 day for an empty / all-invalid schedule", () => {
    process.env.DUNNING_INTERVAL_DAYS = " , ,-2,abc";
    expect(intervalDays(1)).toBe(1);
  });

  it("treats attempt < 1 as the first element", () => {
    process.env.DUNNING_INTERVAL_DAYS = "2,4";
    expect(intervalDays(0)).toBe(2);
  });
});

describe("dunningRetries", () => {
  it("reads a valid positive integer from DUNNING_RETRIES", () => {
    process.env.DUNNING_RETRIES = "5";
    expect(dunningRetries()).toBe(5);
  });

  it("defaults to 3 when unset", () => {
    delete process.env.DUNNING_RETRIES;
    expect(dunningRetries()).toBe(3);
  });

  it("defaults to 3 for a non-numeric value", () => {
    process.env.DUNNING_RETRIES = "abc";
    expect(dunningRetries()).toBe(3);
  });

  it("defaults to 3 for a non-positive or non-integer value", () => {
    process.env.DUNNING_RETRIES = "0";
    expect(dunningRetries()).toBe(3);
    process.env.DUNNING_RETRIES = "-2";
    expect(dunningRetries()).toBe(3);
    process.env.DUNNING_RETRIES = "2.5";
    expect(dunningRetries()).toBe(3);
  });
});

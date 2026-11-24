import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutosaveController,
  CompanySaveCoordinator,
  type Draft,
} from "../controller";
const ok = { ok: true as const, data: {} };
const options = (save = vi.fn(async (_patch: Draft) => ok)) => ({
  baseline: { name: "Original", country: "SI" },
  enabled: true,
  save,
});
afterEach(() => vi.useRealTimers());

describe("F09 follow-up: autosave lifecycle", () => {
  it("renders every 500ms cannot postpone an edit's 1200ms deadline", async () => {
    vi.useFakeTimers();
    const opts = options();
    const form = new AutosaveController(opts);
    form.mount();
    form.set({ name: "Edited" });
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(500);
      form.update({ ...opts, baseline: { ...opts.baseline } });
    }
    expect(opts.save).toHaveBeenCalledExactlyOnceWith({ name: "Edited" });
    form.dispose();
  });
  it("refreshes the save callback without postponing the timer, even when an unrelated baseline field changes", async () => {
    vi.useFakeTimers();
    const opts = options();
    const nextSave = vi.fn(async (_patch: Draft) => ok);
    const form = new AutosaveController(opts);
    form.mount();
    form.set({ name: "Edited" });
    await vi.advanceTimersByTimeAsync(1000);
    form.update({
      ...opts,
      save: nextSave,
      baseline: { ...opts.baseline, country: "DE" },
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(opts.save).not.toHaveBeenCalled();
    expect(nextSave).toHaveBeenCalledWith({ name: "Edited" });
    form.dispose();
  });
  it("disabling cancels the timer, re-enabling starts one; acknowledged baseline cancels a redundant save", async () => {
    vi.useFakeTimers();
    const opts = options();
    const form = new AutosaveController(opts);
    form.mount();
    form.set({ name: "Edited" });
    await vi.advanceTimersByTimeAsync(1000);
    form.update({ ...opts, enabled: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(opts.save).not.toHaveBeenCalled();
    form.update(opts);
    await vi.advanceTimersByTimeAsync(1000);
    form.update({ ...opts, baseline: { ...opts.baseline, name: "Edited" } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(opts.save).not.toHaveBeenCalled();
    form.dispose();
  });
  it("closing a form before debounce saves now, not minutes later on company switching", async () => {
    vi.useFakeTimers();
    const coordinator = new CompanySaveCoordinator();
    const opts = options();
    const form = coordinator.form("A:row", opts);
    form.mount();
    form.set({ name: "Closing" });
    expect(await coordinator.detach("A:row", form)).toBe(true);
    expect(opts.save).toHaveBeenCalledExactlyOnceWith({ name: "Closing" });
    expect(coordinator.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    await coordinator.prepare();
    expect(opts.save).toHaveBeenCalledTimes(1);
    coordinator.finish(true);
  });
  it("Strict Mode cleanup/setup does not cause an extra save", async () => {
    vi.useFakeTimers();
    const coordinator = new CompanySaveCoordinator();
    const opts = options();
    const form = coordinator.form("A:profile", opts);
    form.mount();
    form.set({ name: "Edited" });
    const detached = coordinator.detach("A:profile", form);
    coordinator.attach("A:profile", form);
    form.mount();
    expect(await detached).toBe(true);
    expect(opts.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1200);
    expect(opts.save).toHaveBeenCalledTimes(1);
    coordinator.finish(true);
  });
  it("a refused detached save retains its owned draft and signals a visible error", async () => {
    const coordinator = new CompanySaveCoordinator();
    const save = vi.fn().mockResolvedValue({ ok: false, kind: "unknown" });
    const opts = options(save);
    const form = coordinator.form("A:row", opts);
    form.mount();
    form.set({ name: "Unsaved" });
    expect(await coordinator.detach("A:row", form)).toBe(false);
    expect(coordinator.form("A:row", opts)).toBe(form);
    expect(form.view.values.name).toBe("Unsaved");
    expect(form.view.status).toBe("refused");
    expect(coordinator.pending).toBe(true);
    coordinator.finish(true);
  });
  it("a disabled detached form stays recoverable and reports failure", async () => {
    const coordinator = new CompanySaveCoordinator();
    const opts = { ...options(), enabled: false };
    const form = coordinator.form("A:row", opts);
    form.mount();
    form.set({ name: "Needs reason" });
    expect(await coordinator.detach("A:row", form)).toBe(false);
    expect(opts.save).not.toHaveBeenCalled();
    expect(form.dirty).toBe(true);
    coordinator.finish(true);
  });
  it("successful switch disposal does not flush an explicitly discarded draft on React cleanup", async () => {
    const coordinator = new CompanySaveCoordinator();
    const opts = options();
    const form = coordinator.form("A:row", opts);
    form.mount();
    form.set({ name: "Discarded" });
    coordinator.finish(true);
    expect(await coordinator.detach("A:row", form)).toBe(true);
    expect(opts.save).not.toHaveBeenCalled();
  });
  it("an already pending save and unmount share one request", async () => {
    const coordinator = new CompanySaveCoordinator();
    let resolve!: (value: typeof ok) => void;
    const save = vi.fn(
      () =>
        new Promise<typeof ok>((done) => {
          resolve = done;
        }),
    );
    const form = coordinator.form("A:row", options(save));
    form.mount();
    form.set({ name: "A" });
    const saving = form.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const detached = coordinator.detach("A:row", form);
    resolve(ok);
    await saving;
    expect(await detached).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(coordinator.pending).toBe(false);
  });
});

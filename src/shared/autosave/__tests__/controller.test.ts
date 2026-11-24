import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutosaveController,
  CompanySaveCoordinator,
  type Draft,
} from "../controller";

const ok = { ok: true as const, data: {} };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const options = (save = vi.fn(async (_patch: Draft) => ok)) => ({
  baseline: { name: "Original" },
  enabled: true,
  save,
});
afterEach(() => {
  vi.useRealTimers();
});

describe("F09: autosave ownership and acknowledgement", () => {
  it("clears acknowledged draft; a later server baseline cannot turn it into a new write", async () => {
    const opts = options();
    const form = new AutosaveController(opts);
    form.set({ name: "Saved A" });
    await form.flush();
    expect(form.view.status).toBe("saved");
    expect(form.patch).toEqual({});
    form.update({ ...opts, baseline: { name: "Changed on server" } });
    expect(form.view.values.name).toBe("Changed on server");
    await form.flush();
    expect(opts.save).toHaveBeenCalledTimes(1);
  });
  it("keeps newer typing, including reverting to the original value, and serialises all confirmations", async () => {
    const first = deferred<typeof ok>();
    const second = deferred<typeof ok>();
    const save = vi
      .fn<(patch: Draft) => Promise<typeof ok>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const form = new AutosaveController(options(save));
    form.set({ name: "First" });
    const a = form.flush();
    const b = form.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    form.set({ name: "Original" });
    first.resolve(ok);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(form.view.values.name).toBe("Original");
    expect(form.view.status).toBe("saving");
    expect(save.mock.calls).toEqual([
      [{ name: "First" }],
      [{ name: "Original" }],
    ]);
    second.resolve(ok);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(form.patch).toEqual({});
    expect(form.view.status).toBe("saved");
  });
  it("does not erase another field typed while a request is pending", async () => {
    const response = deferred<typeof ok>();
    const save = vi
      .fn()
      .mockReturnValueOnce(response.promise)
      .mockResolvedValue(ok);
    const form = new AutosaveController(options(save));
    form.set({ name: "A" });
    const pending = form.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    form.set({ country: "SI" });
    response.resolve(ok);
    await pending;
    expect(save.mock.calls[1]).toEqual([{ country: "SI" }]);
    expect(form.view.values).toEqual({ name: "A", country: "SI" });
  });
  it("keeps canonical values returned by the server's refetch", async () => {
    const response = deferred<typeof ok>();
    const save = vi.fn().mockReturnValue(response.promise);
    const form = new AutosaveController(options(save));
    form.set({ name: " Trim me " });
    const pending = form.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    form.update({ ...options(save), baseline: { name: "Trim me" } });
    response.resolve(ok);
    await pending;
    expect(form.view.values.name).toBe("Trim me");
  });
  it("retains refused input and does not endlessly retry a refusal", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({ ok: false, kind: "unknown" });
    const form = new AutosaveController(options(save));
    form.mount();
    form.set({ name: "Draft" });
    await vi.advanceTimersByTimeAsync(1200);
    expect(form.view.status).toBe("refused");
    expect(form.view.values.name).toBe("Draft");
    await vi.advanceTimersByTimeAsync(10000);
    expect(save).toHaveBeenCalledTimes(1);
    save.mockResolvedValue(ok);
    form.confirm();
    await vi.runAllTimersAsync();
    expect(form.view.status).toBe("saved");
    form.dispose();
  });
  it("handles a thrown transport error without losing the draft", async () => {
    const save = vi.fn().mockRejectedValue(new Error("offline"));
    const form = new AutosaveController(options(save));
    form.set({ name: "A" });
    expect(await form.flush()).toBe(false);
    expect(form.view.refusal).toMatchObject({ kind: "unknown" });
    expect(form.dirty).toBe(true);
  });
  it("cancels the old object's timer and isolates its late response from a new object", async () => {
    vi.useFakeTimers();
    const response = deferred<typeof ok>();
    const oldSave = vi.fn().mockReturnValue(response.promise),
      newSave = vi.fn().mockResolvedValue(ok);
    const old = new AutosaveController(options(oldSave));
    old.mount();
    old.set({ name: "Old" });
    old.unmount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(oldSave).not.toHaveBeenCalled();
    const oldRequest = old.flush();
    await vi.advanceTimersByTimeAsync(0);
    const next = new AutosaveController({
      ...options(newSave),
      baseline: { name: "B" },
    });
    next.mount();
    response.resolve(ok);
    await oldRequest;
    await vi.advanceTimersByTimeAsync(2000);
    expect(next.view.values.name).toBe("B");
    expect(newSave).not.toHaveBeenCalled();
    next.dispose();
  });
});

describe("F09: company switch barrier", () => {
  it.each([false, true])(
    "saves only A before switching, already saved = %s",
    async (alreadySaved) => {
      vi.useFakeTimers();
      const coordinator = new CompanySaveCoordinator();
      const saveA = vi.fn().mockResolvedValue(ok),
        saveB = vi.fn().mockResolvedValue(ok);
      const a = coordinator.form("A:profile:entity-a", options(saveA));
      a.mount();
      a.set({ name: "Edited A" });
      if (alreadySaved) await vi.advanceTimersByTimeAsync(1200);
      expect(await coordinator.prepare()).toBe(true);
      coordinator.finish(true);
      a.unmount();
      const b = coordinator.form("B:profile:entity-b", {
        ...options(saveB),
        baseline: { name: "B" },
      });
      b.mount();
      await vi.advanceTimersByTimeAsync(5000);
      expect(saveA).toHaveBeenCalledTimes(1);
      expect(saveB).not.toHaveBeenCalled();
      expect(b.view.values.name).toBe("B");
      coordinator.finish(true);
    },
  );
  it("waits for a delayed save and other already started writes; blocks rapid repeat switches", async () => {
    const coordinator = new CompanySaveCoordinator();
    const response = deferred<typeof ok>();
    const manual = deferred<void>();
    const request = coordinator.write(() => manual.promise);
    const save = vi.fn().mockReturnValue(response.promise);
    const a = coordinator.form("A:profile", options(save));
    a.set({ name: "A" });
    let ready = false;
    const switching = coordinator.prepare().then((saved) => {
      ready = true;
      return saved;
    });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await expect(coordinator.prepare()).rejects.toThrow("already in progress");
    response.resolve(ok);
    await Promise.resolve();
    expect(ready).toBe(false);
    manual.resolve();
    await request;
    expect(await switching).toBe(true);
    await expect(coordinator.write(async () => ok)).rejects.toThrow(
      "switch in progress",
    );
    coordinator.finish(true);
  });
  it("a failed save requires a decision; staying preserves the draft, failed switching does too", async () => {
    const coordinator = new CompanySaveCoordinator();
    const save = vi.fn().mockResolvedValue({ ok: false, kind: "unknown" });
    const a = coordinator.form("A:profile", options(save));
    a.set({ name: "Unsaved A" });
    expect(await coordinator.prepare()).toBe(false);
    expect(a.view.status).toBe("refused");
    coordinator.finish(false);
    expect(a.view.values.name).toBe("Unsaved A");
    expect(coordinator.form("A:profile", options(save))).toBe(a);
    expect(await coordinator.prepare()).toBe(false);
    coordinator.finish(false);
    expect(a.dirty).toBe(true);
    save.mockResolvedValue(ok);
    expect(await coordinator.prepare()).toBe(true);
    coordinator.finish(true);
  });
  it("explicit discard happens only after all requests settle and a successful switch", async () => {
    const coordinator = new CompanySaveCoordinator();
    const saveA = vi.fn().mockResolvedValue({ ok: false, kind: "unknown" });
    const a = coordinator.form("A:profile", options(saveA));
    a.set({ name: "Unsaved" });
    expect(await coordinator.prepare()).toBe(false);
    expect(coordinator.pending).toBe(true);
    coordinator.finish(true);
    expect(coordinator.pending).toBe(false);
    const fresh = coordinator.form("A:profile", options(saveA));
    expect(fresh.view.values.name).toBe("Original");
  });
  it("detached dirty forms retain their owner and are flushed before a company switch", async () => {
    const coordinator = new CompanySaveCoordinator();
    const save = vi.fn().mockResolvedValue(ok);
    const form = coordinator.form("A:boundary:period-1", options(save));
    form.mount();
    form.set({ name: "A period" });
    form.unmount();
    expect(coordinator.pending).toBe(true);
    expect(await coordinator.prepare()).toBe(true);
    expect(save).toHaveBeenCalledWith({ name: "A period" });
    coordinator.finish(true);
  });
  it("a disabled dirty form cannot be silently discarded as successfully saved", async () => {
    const coordinator = new CompanySaveCoordinator();
    const save = vi.fn().mockResolvedValue(ok);
    const a = coordinator.form("A:row", { ...options(save), enabled: false });
    a.set({ name: "Needs a reason" });
    expect(await coordinator.prepare()).toBe(false);
    expect(save).not.toHaveBeenCalled();
    coordinator.finish(false);
    expect(a.dirty).toBe(true);
  });
});

describe("F09: versioned inventory writes", () => {
  it("follows a new row id without losing newer input or sending it to the superseded version", async () => {
    const coordinator = new CompanySaveCoordinator();
    const response = deferred<typeof ok>();
    let id = "v1";
    const writes: { id: string; patch: Draft }[] = [];
    const save = vi.fn(async (patch: Draft) => {
      writes.push({ id, patch });
      if (id === "v1") {
        await response.promise;
        coordinator.follow("A:row:v1", "A:row:v2");
        id = "v2";
      }
      return ok;
    });
    const v1 = coordinator.form("A:row:v1", options(save));
    v1.mount();
    v1.set({ name: "First" });
    const pending = v1.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    v1.set({ name: "Newer typing" });
    response.resolve(ok);
    await pending;
    v1.unmount();
    coordinator.release("A:row:v1", v1);
    const v2 = coordinator.form("A:row:v2", options(save));
    expect(v2).toBe(v1);
    expect(v2.view.values.name).toBe("Newer typing");
    expect(writes).toEqual([
      { id: "v1", patch: { name: "First" } },
      { id: "v2", patch: { name: "Newer typing" } },
    ]);
    coordinator.finish(true);
  });
});

describe("F09: mounting and no-op edits", () => {
  it("an edit reverted before saving cannot be replayed after a server update", async () => {
    const opts = options();
    const form = new AutosaveController(opts);
    form.set({ name: "Temporary" });
    form.set({ name: "Original" });
    expect(form.dirty).toBe(false);
    form.update({ ...opts, baseline: { name: "External change" } });
    expect(form.view.values.name).toBe("External change");
    await form.flush();
    expect(opts.save).not.toHaveBeenCalled();
  });
  it("effect cleanup/setup retains switch protection in React Strict Mode", async () => {
    const coordinator = new CompanySaveCoordinator();
    const opts = options();
    const form = coordinator.form("A:profile", opts);
    coordinator.attach("A:profile", form);
    form.mount();
    form.unmount();
    coordinator.release("A:profile", form);
    coordinator.attach("A:profile", form);
    form.mount();
    form.set({ name: "After remount" });
    expect(await coordinator.prepare()).toBe(true);
    expect(opts.save).toHaveBeenCalledWith({ name: "After remount" });
    coordinator.finish(true);
  });
});

describe("F09: late callbacks from the previous company", () => {
  it("rejects an old create/write callback even after switching has finished", async () => {
    const coordinator = new CompanySaveCoordinator("A");
    const oldRequest = vi.fn(async () => ok);
    await coordinator.write(oldRequest, "A");
    expect(await coordinator.prepare()).toBe(true);
    coordinator.bind("B");
    coordinator.finish(true);
    await expect(coordinator.write(oldRequest, "A")).rejects.toThrow(
      "context changed",
    );
    expect(oldRequest).toHaveBeenCalledTimes(1);
    const newRequest = vi.fn(async () => ok);
    await coordinator.write(newRequest, "B");
    expect(newRequest).toHaveBeenCalledTimes(1);
  });
});

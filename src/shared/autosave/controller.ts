import type {
  Refusal,
  WriteOutcome,
} from "@/app/[locale]/(app)/organisation/_lib/api";

export type Draft = Record<string, string>;
export type SaveStatus = "clean" | "dirty" | "saving" | "saved" | "refused";
export const autosaveKey = (
  companyId: string | undefined,
  contextKey: string,
) => JSON.stringify([companyId ?? null, contextKey]);

type Options = {
  baseline: Draft;
  save: (patch: Draft) => Promise<WriteOutcome<unknown>>;
  enabled: boolean;
};

/** One instance belongs to exactly one company/form/object. Never retarget it. */
export class AutosaveController {
  private baseline: Draft;
  private baselineJson: string;
  private draft: Draft = {};
  private edits: Record<string, number> = {};
  private revision = 0;
  private saved = false;
  private refusal: Refusal | null = null;
  private options: Options;
  private flight: Promise<boolean> | null = null;
  private drain: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private paused = false;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(options: Options) {
    this.options = options;
    this.baseline = options.baseline;
    this.baselineJson = JSON.stringify(options.baseline);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  private emit() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }
  get patch(): Draft {
    return Object.fromEntries(
      Object.entries(this.draft).filter(
        ([key, value]) => value !== (this.baseline[key] ?? ""),
      ),
    );
  }
  get dirty() {
    return Object.keys(this.patch).length > 0;
  }
  get pending() {
    return this.dirty || this.flight !== null;
  }
  get view() {
    const status: SaveStatus = this.flight
      ? "saving"
      : this.refusal
        ? "refused"
        : this.dirty
          ? "dirty"
          : this.saved
            ? "saved"
            : "clean";
    return {
      values: { ...this.baseline, ...this.draft },
      patch: this.patch,
      dirty: this.dirty,
      status,
      refusal: this.refusal,
      set: this.set,
      confirm: this.confirm,
    };
  }
  update(options: Options) {
    const enabledChanged = options.enabled !== this.options.enabled;
    const previousPatch = JSON.stringify(this.patch);
    this.options = options;
    const json = JSON.stringify(options.baseline);
    if (json !== this.baselineJson) {
      this.baselineJson = json;
      this.baseline = options.baseline;
      this.emit();
    }
    // Render-only updates refresh the callback but keep the edit's deadline.
    if (enabledChanged || previousPatch !== JSON.stringify(this.patch))
      this.schedule();
  }
  set = (patch: Draft) => {
    for (const [key, value] of Object.entries(patch)) {
      if (!this.flight && value === (this.baseline[key] ?? ""))
        delete this.draft[key];
      else this.draft[key] = value;
      this.edits[key] = ++this.revision;
    }
    this.refusal = null;
    this.emit();
    this.schedule();
  };
  private cancelTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule() {
    this.cancelTimer();
    if (
      this.active &&
      !this.paused &&
      this.options.enabled &&
      this.dirty &&
      !this.flight &&
      !this.refusal
    ) {
      this.timer = setTimeout(() => {
        void this.flush();
      }, 1200);
    }
  }
  mount() {
    this.active = true;
    this.schedule();
  }
  unmount() {
    this.active = false;
    this.cancelTimer();
  }
  get mounted() {
    return this.active;
  }
  pause() {
    this.paused = true;
    this.cancelTimer();
  }
  resume() {
    this.paused = false;
    this.schedule();
  }
  dispose() {
    this.unmount();
    this.listeners.clear();
  }
  confirm = () => {
    void this.flush();
  };

  /** Serialises requests and drains newer edits without clearing them on an older ACK. */
  flush(): Promise<boolean> {
    this.cancelTimer();
    if (!this.drain) {
      this.drain = Promise.resolve()
        .then(() => this.drainDraft())
        .finally(() => {
          this.drain = null;
        });
    }
    return this.drain;
  }

  private async drainDraft(): Promise<boolean> {
    while (this.dirty) {
      if (!this.options.enabled) return false;
      const payload = this.patch;
      const versions = { ...this.edits };
      const baselineJson = this.baselineJson;
      const save = this.options.save;
      this.flight = Promise.resolve().then(async () => {
        let result: WriteOutcome<unknown>;
        try {
          result = await save(payload);
        } catch {
          result = { ok: false, kind: "unknown" };
        }
        if (!result.ok) {
          this.refusal = result;
          return false;
        }
        if (this.baselineJson === baselineJson)
          this.baseline = { ...this.baseline, ...payload };
        for (const key of Object.keys(payload)) {
          if (this.edits[key] === versions[key]) delete this.draft[key];
        }
        this.refusal = null;
        this.saved = true;
        return true;
      });
      this.emit();
      const success = await this.flight;
      this.flight = null;
      this.emit();
      if (!success) return false;
    }
    return true;
  }
}

/** Scoped to one mounted application; no cross-user module singleton. */
export class CompanySaveCoordinator {
  private forms = new Map<string, AutosaveController>();
  private writes = new Set<Promise<unknown>>();
  private phase: "idle" | "preparing" | "switching" = "idle";
  constructor(private companyId?: string) {}
  bind(companyId: string | undefined) {
    this.companyId = companyId;
  }

  form(key: string, options: Options) {
    let form = this.forms.get(key);
    if (!form) {
      form = new AutosaveController(options);
      if (this.phase !== "idle") form.pause();
      this.forms.set(key, form);
    }
    return form;
  }
  /** A successful versioned write changes the id, but keeps newer input owned
   * by that same logical row. The caller also advances its write target. */
  follow(from: string, to: string) {
    const form = this.forms.get(from);
    if (!form || from === to) return;
    if (this.forms.has(to)) throw new Error("Autosave target already exists");
    this.forms.delete(from);
    this.forms.set(to, form);
  }
  attach(key: string, form: AutosaveController) {
    if (!this.forms.has(key)) this.forms.set(key, form);
  }
  release(key: string, form: AutosaveController) {
    if (!form.pending && this.forms.get(key) === form) {
      this.forms.delete(key);
      form.dispose();
    }
  }
  async detach(key: string, form: AutosaveController): Promise<boolean> {
    form.unmount();
    // React Strict Mode performs cleanup/setup synchronously. Give that setup
    // a chance to reattach before treating this as a real close/navigation.
    await Promise.resolve();
    if (
      form.mounted ||
      this.phase !== "idle" ||
      ![...this.forms.values()].includes(form)
    )
      return true;
    const saved = await form.flush();
    if (form.mounted || this.phase !== "idle") return true;
    // Versioned writes may have moved this controller to its successor's key.
    this.release(key, form);
    for (const [ownedKey, ownedForm] of this.forms) {
      if (ownedForm === form) this.release(ownedKey, form);
    }
    return saved;
  }
  get pending() {
    return (
      this.writes.size > 0 ||
      [...this.forms.values()].some((form) => form.pending)
    );
  }
  async write<T>(operation: () => Promise<T>, companyId?: string): Promise<T> {
    if (this.phase === "switching")
      throw new Error("Company switch in progress");
    const promise = Promise.resolve().then(() => {
      if (companyId !== this.companyId)
        throw new Error("Company context changed");
      return operation();
    });
    this.writes.add(promise);
    try {
      return await promise;
    } finally {
      this.writes.delete(promise);
    }
  }
  async prepare(): Promise<boolean> {
    if (this.phase !== "idle")
      throw new Error("Company switch already in progress");
    this.phase = "preparing";
    this.forms.forEach((form) => form.pause());
    let success = true;
    for (const form of this.forms.values()) {
      if (!(await form.flush())) success = false;
    }
    while (this.writes.size) await Promise.allSettled([...this.writes]);
    this.phase = "switching";
    return success;
  }
  finish(switched: boolean) {
    if (switched) {
      this.forms.forEach((form) => form.dispose());
      this.forms.clear();
    }
    this.phase = "idle";
    this.forms.forEach((form) => form.resume());
  }
}

import { stringValueCost } from "../core/byteCost.js";
import type { MemoryAccountant } from "../core/MemoryAccountant.js";

export class StringStore {
  private data = new Map<string, string>();

  constructor(private readonly accountant?: MemoryAccountant) {}

  set(key: string, value: string) {
    // Touch first so an eviction triggered by tryCharge cannot pick
    // the key we're about to write. See MemoryAccountant for the rule.
    this.accountant?.touch(key);
    const previous = this.data.get(key);
    const newCost = stringValueCost(value);
    const oldCost = previous !== undefined ? stringValueCost(previous) : 0;
    const delta = newCost - oldCost;
    if (delta > 0) this.accountant?.tryCharge(delta);
    else if (delta < 0) this.accountant?.credit(-delta);
    this.data.set(key, value);
  }

  get(key: string): string | null {
    const value = this.data.get(key);
    if (value !== undefined) this.accountant?.touch(key);
    return value ?? null;
  }

  /**
   * Append `value` to the existing string at `key`, or set it if missing.
   * Returns the new length of the string. Standard APPEND semantics.
   */
  append(key: string, value: string): number {
    this.accountant?.touch(key);
    const existing = this.data.get(key) ?? "";
    const next = existing + value;
    // Charge only the delta — appended bytes plus header overhead if new.
    const delta =
      stringValueCost(next) -
      (existing.length > 0 ? stringValueCost(existing) : 0);
    if (delta > 0) this.accountant?.tryCharge(delta);
    this.data.set(key, next);
    return next.length;
  }

  delete(key: string) {
    const previous = this.data.get(key);
    if (previous === undefined) return;
    this.accountant?.credit(stringValueCost(previous));
    this.data.delete(key);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  keys(): IterableIterator<string> {
    return this.data.keys();
  }

  export() {
    return Object.fromEntries(this.data);
  }

  import(data: Record<string, string>) {
    // Credit any existing values before replacing.
    for (const v of this.data.values()) {
      this.accountant?.credit(stringValueCost(v));
    }
    this.data = new Map(Object.entries(data));
    // Force-charge the imported values: snapshot import bypasses the
    // cap by design so the restored state matches what was saved.
    for (const v of this.data.values()) {
      this.accountant?.forceCharge(stringValueCost(v));
    }
  }
}

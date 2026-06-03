/**
 * @file aof-log.test.ts
 *
 * Unit tests for the on-disk AOF.
 *
 * What we're locking down:
 *   1. append → replay round-trip preserves entries in order.
 *   2. Replay tolerates a torn (incomplete) trailing line — common
 *      after a hard kill mid-write.
 *   3. Replay tolerates a corrupt JSON line — logged + skipped, not fatal.
 *   4. The `replaying` flag makes append a no-op during replay so
 *      hooked dispatchers don't double-log.
 *   5. Rewrite atomically replaces the file with a smaller equivalent
 *      and the new content replays identically.
 *   6. close() flushes and is idempotent.
 *
 * fsync policies are not exhaustively asserted at the syscall level (no
 * portable way to introspect that). We only verify the constructor
 * accepts each value and the timer is ref-safe.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AofLog, type AofEntry } from "../../src/services/AofLog.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "erix-aof-test-"));
  path = join(dir, "aof.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("AofLog — append + replay", () => {
  it("round-trips entries in order", () => {
    const aof = new AofLog({ path, fsyncPolicy: "no" });
    aof.append({ tenantId: "t", name: "SET", args: ["k", "v"] });
    aof.append({ tenantId: "t", name: "INCR", args: ["counter"] });
    aof.append({ tenantId: "u", name: "DEL", args: ["x"] });
    aof.close();

    const replayed: AofEntry[] = [];
    const reopened = new AofLog({ path, fsyncPolicy: "no" });
    const count = reopened.replay((e) => replayed.push(e));
    reopened.close();

    expect(count).toBe(3);
    expect(replayed.map((e) => [e.tenantId, e.name, e.args])).toEqual([
      ["t", "SET", ["k", "v"]],
      ["t", "INCR", ["counter"]],
      ["u", "DEL", ["x"]],
    ]);
  });

  it("returns 0 when replaying a missing file", () => {
    const aof = new AofLog({ path: join(dir, "does-not-exist.log") });
    expect(aof.replay(() => {})).toBe(0);
    aof.close();
  });

  it("tolerates a torn trailing line (kill mid-write)", () => {
    // Write two complete entries plus an incomplete trailing one — the
    // shape of the file when the process was killed mid-write.
    const incomplete = `${JSON.stringify({ ts: 1, tenantId: "t", name: "SET", args: ["a", "1"] })}\n${JSON.stringify({ ts: 2, tenantId: "t", name: "SET", args: ["b", "2"] })}\n{"ts":3,"tenantId":"t","name":"S`;
    writeFileSync(path, incomplete);

    const aof = new AofLog({ path });
    const seen: string[] = [];
    const count = aof.replay((e) => seen.push(`${e.name}:${e.args.join(",")}`));
    aof.close();

    expect(count).toBe(2);
    expect(seen).toEqual(["SET:a,1", "SET:b,2"]);
  });

  it("tolerates a single corrupt JSON line in the middle", () => {
    const text = [
      JSON.stringify({ ts: 1, tenantId: "t", name: "SET", args: ["a", "1"] }),
      "{not even close to JSON}",
      JSON.stringify({ ts: 3, tenantId: "t", name: "SET", args: ["c", "3"] }),
      "",
    ].join("\n");
    writeFileSync(path, text);

    const aof = new AofLog({ path });
    const names: string[] = [];
    const count = aof.replay((e) => names.push(e.name));
    aof.close();

    expect(count).toBe(2);
    expect(names).toEqual(["SET", "SET"]);
  });

  it("rejects entries that are missing required fields", () => {
    const text = [
      JSON.stringify({ ts: 1, tenantId: "t", name: "SET", args: ["a"] }),
      // Missing `name`
      JSON.stringify({ ts: 2, tenantId: "t", args: ["b"] }),
      // Missing `tenantId`
      JSON.stringify({ ts: 3, name: "SET", args: ["c"] }),
      // `args` is not an array
      JSON.stringify({ ts: 4, tenantId: "t", name: "SET", args: "wrong" }),
      "",
    ].join("\n");
    writeFileSync(path, text);

    const aof = new AofLog({ path });
    let count = 0;
    aof.replay(() => {
      count++;
    });
    aof.close();
    expect(count).toBe(1);
  });

  it("append is suppressed during replay", () => {
    // A dispatcher hooked to AofLog will both apply the entry and try
    // to re-append it. The replaying flag must mute that second write
    // so the file does not double itself on every restart.
    const aof = new AofLog({ path, fsyncPolicy: "no" });
    aof.append({ tenantId: "t", name: "SET", args: ["k", "v"] });
    aof.close();

    const reopened = new AofLog({ path, fsyncPolicy: "no" });
    reopened.replay(() => {
      // simulate a dispatcher that double-appends.
      reopened.append({
        tenantId: "t",
        name: "SET",
        args: ["k", "v"],
      });
    });
    reopened.close();

    // File length should reflect the original write only.
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });
});

describe("AofLog — rewrite", () => {
  it("atomically replaces the file with the supplied entries", () => {
    const aof = new AofLog({ path, fsyncPolicy: "no" });
    // Original log: 1k repetitive writes.
    for (let i = 0; i < 1000; i++) {
      aof.append({ tenantId: "t", name: "INCR", args: ["counter"] });
    }
    const sizeBefore = aof.sizeBytes;

    aof.rewrite([{ tenantId: "t", name: "SET", args: ["counter", "1000"] }]);

    expect(aof.sizeBytes).toBeLessThan(sizeBefore);

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.name).toBe("SET");
    expect(parsed.args).toEqual(["counter", "1000"]);

    aof.close();
  });

  it("replay after rewrite reconstructs the rewritten entries", () => {
    const aof = new AofLog({ path, fsyncPolicy: "no" });
    aof.append({ tenantId: "t", name: "SET", args: ["a", "old"] });
    aof.rewrite([{ tenantId: "t", name: "SET", args: ["a", "new"] }]);
    aof.close();

    const reopened = new AofLog({ path, fsyncPolicy: "no" });
    const seen: string[] = [];
    reopened.replay((e) =>
      seen.push(`${e.name}:${(e.args[1] as string) ?? ""}`),
    );
    reopened.close();
    expect(seen).toEqual(["SET:new"]);
  });

  it("rewrite leaves no .rewrite tmp file behind on success", () => {
    const aof = new AofLog({ path, fsyncPolicy: "no" });
    aof.rewrite([{ tenantId: "t", name: "PING", args: [] }]);
    aof.close();
    expect(existsSync(`${path}.rewrite`)).toBe(false);
  });
});

describe("AofLog — fsync policies", () => {
  it("accepts every documented policy", () => {
    for (const policy of ["always", "everysec", "no"] as const) {
      const localPath = join(dir, `${policy}.log`);
      const aof = new AofLog({ path: localPath, fsyncPolicy: policy });
      aof.append({ tenantId: "t", name: "PING", args: [] });
      aof.close();
      expect(existsSync(localPath)).toBe(true);
    }
  });
});

describe("AofLog — close", () => {
  it("is idempotent", () => {
    const aof = new AofLog({ path });
    aof.close();
    expect(() => aof.close()).not.toThrow();
  });
});

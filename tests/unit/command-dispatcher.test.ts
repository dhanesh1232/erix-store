/**
 * @file command-dispatcher.test.ts
 *
 * Unit tests for the synchronous command dispatcher used by MULTI/EXEC.
 *
 * Beyond the obvious "verbs work" coverage, this file pins down two
 * properties the transaction layer relies on:
 *
 *   1. Tenant prefixing happens inside the dispatcher, in one place.
 *      A transaction running for tenant A cannot read or mutate
 *      tenant B's data, no matter what command name is used.
 *
 *   2. Errors do not abort the batch. Per-command failures appear in
 *      the result array as `{ ok: false, error }`; subsequent commands
 *      still execute. Matches Redis MULTI/EXEC semantics.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ErixStore } from "../../src/core/Store.js";
import {
  dispatchCommand,
  dispatchTransaction,
  listVerbs,
} from "../../src/server/commands.js";
import { PriorityQueue } from "../../src/services/PriorityQueue.js";

describe("dispatchCommand", () => {
  let store: ErixStore;
  afterEach(() => store.ttlManager.stopSweep());

  describe("PING", () => {
    it("returns PONG with no args", () => {
      store = new ErixStore();
      const r = dispatchCommand({ store }, "t", { name: "PING", args: [] });
      expect(r).toEqual({ ok: true, value: "PONG" });
    });

    it("echoes the message when given one arg", () => {
      store = new ErixStore();
      const r = dispatchCommand({ store }, "t", {
        name: "PING",
        args: ["hello"],
      });
      expect(r).toEqual({ ok: true, value: "hello" });
    });
  });

  describe("SET / GET / DEL / EXPIRE / TTL / PERSIST", () => {
    it("SET stores a string and returns OK", () => {
      store = new ErixStore();
      const r = dispatchCommand({ store }, "t", {
        name: "SET",
        args: ["k", "v"],
      });
      expect(r).toEqual({ ok: true, value: "OK" });
    });

    it("SET with EX attaches a TTL", () => {
      store = new ErixStore();
      dispatchCommand({ store }, "t", {
        name: "SET",
        args: ["k", "v", "EX", 60],
      });
      const r = dispatchCommand({ store }, "t", { name: "TTL", args: ["k"] });
      expect(r.ok && (r.value as number)).toBeGreaterThan(0);
    });

    it("GET returns the stored value", () => {
      store = new ErixStore();
      dispatchCommand({ store }, "t", { name: "SET", args: ["k", "v"] });
      const r = dispatchCommand({ store }, "t", { name: "GET", args: ["k"] });
      expect(r).toEqual({ ok: true, value: "v" });
    });

    it("DEL removes one or more keys, returning the count actually removed", () => {
      store = new ErixStore();
      dispatchCommand({ store }, "t", { name: "SET", args: ["a", "1"] });
      dispatchCommand({ store }, "t", { name: "SET", args: ["b", "2"] });

      const r = dispatchCommand({ store }, "t", {
        name: "DEL",
        args: ["a", "b", "missing"],
      });
      expect(r).toEqual({ ok: true, value: 2 });
    });

    it("EXPIRE returns 0 for missing keys, 1 when applied", () => {
      store = new ErixStore();
      const ghost = dispatchCommand({ store }, "t", {
        name: "EXPIRE",
        args: ["ghost", 60],
      });
      expect(ghost).toEqual({ ok: true, value: 0 });

      dispatchCommand({ store }, "t", { name: "SET", args: ["k", "v"] });
      const ok = dispatchCommand({ store }, "t", {
        name: "EXPIRE",
        args: ["k", 60],
      });
      expect(ok).toEqual({ ok: true, value: 1 });
    });

    it("TTL: -2 for missing, -1 for no TTL, >0 with TTL", () => {
      store = new ErixStore();
      expect(
        dispatchCommand({ store }, "t", { name: "TTL", args: ["ghost"] }),
      ).toEqual({ ok: true, value: -2 });

      dispatchCommand({ store }, "t", { name: "SET", args: ["k", "v"] });
      expect(
        dispatchCommand({ store }, "t", { name: "TTL", args: ["k"] }),
      ).toEqual({ ok: true, value: -1 });

      dispatchCommand({ store }, "t", {
        name: "SET",
        args: ["e", "v", "EX", 30],
      });
      const r = dispatchCommand({ store }, "t", { name: "TTL", args: ["e"] });
      expect(r.ok && (r.value as number)).toBeGreaterThan(0);
    });

    it("PERSIST returns 1 when removing a TTL, 0 otherwise", () => {
      store = new ErixStore();
      dispatchCommand({ store }, "t", {
        name: "SET",
        args: ["k", "v", "EX", 30],
      });
      const r = dispatchCommand({ store }, "t", {
        name: "PERSIST",
        args: ["k"],
      });
      expect(r).toEqual({ ok: true, value: 1 });

      const again = dispatchCommand({ store }, "t", {
        name: "PERSIST",
        args: ["k"],
      });
      expect(again).toEqual({ ok: true, value: 0 });
    });
  });

  describe("Hash / List / Set / ZSet primitives", () => {
    it("HSET / HGET / HDEL", () => {
      store = new ErixStore();
      const set = dispatchCommand({ store }, "t", {
        name: "HSET",
        args: ["h", "f1", "v1", "f2", "v2"],
      });
      expect(set).toEqual({ ok: true, value: 2 });

      expect(
        dispatchCommand({ store }, "t", { name: "HGET", args: ["h", "f1"] }),
      ).toEqual({ ok: true, value: "v1" });

      expect(
        dispatchCommand({ store }, "t", {
          name: "HDEL",
          args: ["h", "f1", "f3"],
        }),
      ).toEqual({ ok: true, value: 1 });
    });

    it("LPUSH / RPUSH / LRANGE / LPOP / RPOP / LLEN", () => {
      store = new ErixStore();
      dispatchCommand({ store }, "t", {
        name: "RPUSH",
        args: ["l", "a", "b", "c"],
      });
      const range = dispatchCommand({ store }, "t", {
        name: "LRANGE",
        args: ["l", 0, -1],
      });
      expect(range).toEqual({ ok: true, value: ["a", "b", "c"] });

      expect(
        dispatchCommand({ store }, "t", { name: "LLEN", args: ["l"] }),
      ).toEqual({ ok: true, value: 3 });

      expect(
        dispatchCommand({ store }, "t", { name: "LPOP", args: ["l"] }),
      ).toEqual({ ok: true, value: "a" });

      expect(
        dispatchCommand({ store }, "t", { name: "RPOP", args: ["l"] }),
      ).toEqual({ ok: true, value: "c" });
    });

    it("SADD / SISMEMBER / SREM / SMEMBERS", () => {
      store = new ErixStore();
      dispatchCommand({ store }, "t", { name: "SADD", args: ["s", "a", "b"] });

      expect(
        dispatchCommand({ store }, "t", {
          name: "SISMEMBER",
          args: ["s", "a"],
        }),
      ).toEqual({ ok: true, value: 1 });

      expect(
        dispatchCommand({ store }, "t", { name: "SREM", args: ["s", "a"] }),
      ).toEqual({ ok: true, value: 1 });

      const r = dispatchCommand({ store }, "t", {
        name: "SMEMBERS",
        args: ["s"],
      });
      expect(r).toEqual({ ok: true, value: ["b"] });
    });

    it("ZADD / ZSCORE / ZRANGE / ZREM", () => {
      store = new ErixStore();
      dispatchCommand({ store }, "t", {
        name: "ZADD",
        args: ["z", 1, "a", 2, "b", 3, "c"],
      });

      expect(
        dispatchCommand({ store }, "t", { name: "ZSCORE", args: ["z", "b"] }),
      ).toEqual({ ok: true, value: 2 });

      expect(
        dispatchCommand({ store }, "t", { name: "ZRANGE", args: ["z", 0, -1] }),
      ).toEqual({ ok: true, value: ["a", "b", "c"] });

      expect(
        dispatchCommand({ store }, "t", {
          name: "ZREM",
          args: ["z", "a", "c"],
        }),
      ).toEqual({ ok: true, value: 2 });
    });
  });

  describe("Priority queue verbs", () => {
    it("ENQUEUE / QLEN / QPEEK / DEQUEUE / QCLEAR work when queue is wired", () => {
      store = new ErixStore();
      const queue = new PriorityQueue();
      const deps = { store, queue };

      dispatchCommand(deps, "t", {
        name: "ENQUEUE",
        args: ["jobs", "v1", 0],
      });
      dispatchCommand(deps, "t", {
        name: "ENQUEUE",
        args: ["jobs", "v2", 5],
      });

      expect(
        dispatchCommand(deps, "t", { name: "QLEN", args: ["jobs"] }),
      ).toEqual({ ok: true, value: 2 });

      expect(
        dispatchCommand(deps, "t", { name: "QPEEK", args: ["jobs"] }),
      ).toEqual({ ok: true, value: "v2" });

      expect(
        dispatchCommand(deps, "t", { name: "DEQUEUE", args: ["jobs"] }),
      ).toEqual({ ok: true, value: "v2" });

      expect(
        dispatchCommand(deps, "t", { name: "QCLEAR", args: ["jobs"] }),
      ).toEqual({ ok: true, value: 1 });
    });

    it("ENQUEUE returns an error when the priority queue is not wired", () => {
      store = new ErixStore();
      const r = dispatchCommand({ store }, "t", {
        name: "ENQUEUE",
        args: ["jobs", "v"],
      });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/priority queue/i);
    });
  });

  describe("Error capture (no throws)", () => {
    it("returns an error result for unknown verbs", () => {
      store = new ErixStore();
      const r = dispatchCommand({ store }, "t", {
        name: "HCF",
        args: [],
      });
      expect(r).toEqual({
        ok: false,
        error: "unknown command 'HCF'",
        code: "UNKNOWN_COMMAND",
      });
    });

    it("captures WRONGTYPE without throwing", () => {
      store = new ErixStore();
      dispatchCommand({ store }, "t", { name: "SET", args: ["k", "v"] });
      const r = dispatchCommand({ store }, "t", {
        name: "LPUSH",
        args: ["k", "x"],
      });
      expect(r.ok).toBe(false);
      expect((r as { code: string }).code).toBe("WRONGTYPE");
    });

    it("captures argument-count errors", () => {
      store = new ErixStore();
      const r = dispatchCommand({ store }, "t", {
        name: "GET",
        args: ["k", "extra"],
      });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(
        /wrong number of arguments/,
      );
    });
  });

  describe("Tenant isolation", () => {
    it("two tenants cannot read each other's keys via the dispatcher", () => {
      store = new ErixStore();
      dispatchCommand({ store }, "alice", {
        name: "SET",
        args: ["k", "alice"],
      });
      dispatchCommand({ store }, "bob", { name: "SET", args: ["k", "bob"] });

      expect(
        dispatchCommand({ store }, "alice", { name: "GET", args: ["k"] }),
      ).toEqual({ ok: true, value: "alice" });
      expect(
        dispatchCommand({ store }, "bob", { name: "GET", args: ["k"] }),
      ).toEqual({ ok: true, value: "bob" });
    });
  });

  it("registers exactly the expected verb set", () => {
    // Lock down the surface so adding/removing a verb forces a deliberate
    // update to the test (and the SDK type if present).
    expect(listVerbs()).toMatchInlineSnapshot(`
      [
        "APPEND",
        "BGREWRITEAOF",
        "BGSAVE",
        "CONFIG",
        "DECR",
        "DECRBY",
        "DEL",
        "DEQUEUE",
        "ENQUEUE",
        "EXISTS",
        "EXPIRE",
        "FLUSHDB",
        "GET",
        "GETSET",
        "HDEL",
        "HEXISTS",
        "HGET",
        "HGETALL",
        "HINCRBY",
        "HKEYS",
        "HLEN",
        "HMGET",
        "HMSET",
        "HSET",
        "HVALS",
        "INCR",
        "INCRBY",
        "LINDEX",
        "LLEN",
        "LPOP",
        "LPUSH",
        "LRANGE",
        "LREM",
        "LTRIM",
        "MGET",
        "MSET",
        "PERSIST",
        "PING",
        "PUBLISH",
        "PUBSUB",
        "QCLEAR",
        "QLEN",
        "QPEEK",
        "RPOP",
        "RPUSH",
        "SADD",
        "SCARD",
        "SDIFF",
        "SET",
        "SETNX",
        "SINTER",
        "SISMEMBER",
        "SLOWLOG",
        "SMEMBERS",
        "SREM",
        "STRLEN",
        "SUNION",
        "TTL",
        "TYPE",
        "ZADD",
        "ZCARD",
        "ZCOUNT",
        "ZINCRBY",
        "ZRANGE",
        "ZRANGEBYSCORE",
        "ZRANK",
        "ZREM",
        "ZREVRANGE",
        "ZSCORE",
      ]
    `);
  });
});

describe("dispatchTransaction", () => {
  let store: ErixStore;
  afterEach(() => store.ttlManager.stopSweep());

  it("returns one result per command in order", () => {
    store = new ErixStore();
    const results = dispatchTransaction({ store }, "t", [
      { name: "SET", args: ["k", "v"] },
      { name: "GET", args: ["k"] },
      { name: "EXISTS", args: ["k"] },
    ]);
    expect(results).toEqual([
      { ok: true, value: "OK" },
      { ok: true, value: "v" },
      { ok: true, value: 1 },
    ]);
  });

  it("does not abort the batch on a per-command error", () => {
    store = new ErixStore();
    const results = dispatchTransaction({ store }, "t", [
      { name: "SET", args: ["k", "v"] },
      { name: "LPUSH", args: ["k", "x"] }, // WRONGTYPE
      { name: "GET", args: ["k"] }, // must still succeed
    ]);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[2]).toEqual({ ok: true, value: "v" });
  });

  it("an empty batch returns an empty array", () => {
    store = new ErixStore();
    expect(dispatchTransaction({ store }, "t", [])).toEqual([]);
  });
});

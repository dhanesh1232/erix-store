/**
 * @file pubsub.test.ts
 *
 * Unit tests for {@link PubSubService} — exact subscribe, pattern subscribe,
 * fan-out delivery, introspection.
 */

import { describe, expect, it, vi } from "vitest";
import { PubSubService } from "../../src/services/PubSub.js";

describe("PubSubService", () => {
	describe("exact subscribe / publish", () => {
		it("delivers messages only to the matching channel's subscribers", () => {
			const ps = new PubSubService();
			const a = vi.fn();
			const b = vi.fn();

			ps.subscribe("ch.a", a);
			ps.subscribe("ch.b", b);
			ps.publish("ch.a", { hello: "world" });

			expect(a).toHaveBeenCalledTimes(1);
			expect(a).toHaveBeenCalledWith({ hello: "world" }, "ch.a");
			expect(b).not.toHaveBeenCalled();
		});

		it("publish returns the count of receivers", () => {
			const ps = new PubSubService();
			ps.subscribe("ch", vi.fn());
			ps.subscribe("ch", vi.fn());
			expect(ps.publish("ch", "x")).toBe(2);
			expect(ps.publish("nobody", "x")).toBe(0);
		});

		it("unsubscribe removes the listener and drops the channel when empty", () => {
			const ps = new PubSubService();
			const cb = vi.fn();
			ps.subscribe("ch", cb);
			ps.unsubscribe("ch", cb);
			expect(ps.publish("ch", "x")).toBe(0);
			expect(ps.listChannels()).toEqual([]);
		});

		it("a listener that unsubscribes itself does not break iteration", () => {
			const ps = new PubSubService();
			const observed: string[] = [];
			const a = (m: unknown) => {
				observed.push(`a:${m}`);
				ps.unsubscribe("ch", a);
			};
			const b = (m: unknown) => {
				observed.push(`b:${m}`);
			};
			ps.subscribe("ch", a);
			ps.subscribe("ch", b);

			ps.publish("ch", "1");
			ps.publish("ch", "2");

			// Both listeners receive "1"; only b receives "2".
			expect(observed).toEqual(["a:1", "b:1", "b:2"]);
		});
	});

	describe("pattern subscribe (PSUBSCRIBE)", () => {
		it("matches glob patterns against published channels", () => {
			const ps = new PubSubService();
			const cb = vi.fn();
			ps.psubscribe("alerts:*", cb);

			ps.publish("alerts:high", { level: 1 });
			ps.publish("alerts:low", { level: 2 });
			ps.publish("metrics:cpu", { level: 3 });

			expect(cb).toHaveBeenCalledTimes(2);
			expect(cb).toHaveBeenCalledWith({ level: 1 }, "alerts:high", "alerts:*");
			expect(cb).toHaveBeenCalledWith({ level: 2 }, "alerts:low", "alerts:*");
		});

		it("a single publish fans out to both exact and pattern subscribers", () => {
			const ps = new PubSubService();
			const exact = vi.fn();
			const pat = vi.fn();
			ps.subscribe("alerts:high", exact);
			ps.psubscribe("alerts:*", pat);

			expect(ps.publish("alerts:high", "boom")).toBe(2);
			expect(exact).toHaveBeenCalledTimes(1);
			expect(pat).toHaveBeenCalledTimes(1);
		});

		it("punsubscribe drops only the supplied listener and cleans up empty patterns", () => {
			const ps = new PubSubService();
			const a = vi.fn();
			const b = vi.fn();
			ps.psubscribe("p:*", a);
			ps.psubscribe("p:*", b);
			ps.punsubscribe("p:*", a);

			ps.publish("p:1", "x");
			expect(a).not.toHaveBeenCalled();
			expect(b).toHaveBeenCalledTimes(1);

			ps.punsubscribe("p:*", b);
			expect(ps.numPat()).toBe(0);
		});
	});

	describe("introspection", () => {
		it("listChannels returns only channels with at least one exact subscriber", () => {
			const ps = new PubSubService();
			ps.subscribe("a", vi.fn());
			ps.subscribe("b", vi.fn());
			ps.psubscribe("c:*", vi.fn()); // patterns are NOT in CHANNELS

			expect(ps.listChannels().sort()).toEqual(["a", "b"]);
		});

		it("listChannels accepts an optional glob filter", () => {
			const ps = new PubSubService();
			ps.subscribe("user:1", vi.fn());
			ps.subscribe("user:2", vi.fn());
			ps.subscribe("system:1", vi.fn());

			expect(ps.listChannels("user:*").sort()).toEqual(["user:1", "user:2"]);
			expect(ps.listChannels("system:*")).toEqual(["system:1"]);
		});

		it("numSub returns 0 for unsubscribed channels", () => {
			const ps = new PubSubService();
			ps.subscribe("a", vi.fn());
			ps.subscribe("a", vi.fn());

			expect(ps.numSub(["a", "b"])).toEqual({ a: 2, b: 0 });
		});

		it("numPat counts unique patterns, not unique listeners", () => {
			const ps = new PubSubService();
			ps.psubscribe("p:*", vi.fn());
			ps.psubscribe("p:*", vi.fn()); // same pattern, same key → still 1
			ps.psubscribe("q:*", vi.fn());

			expect(ps.numPat()).toBe(2);
		});
	});
});

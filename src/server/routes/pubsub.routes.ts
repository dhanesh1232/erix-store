/**
 * @file pubsub.routes.ts
 * @module Server/Routes/PubSub
 *
 * HTTP/SSE surface for pub/sub.
 *
 *   POST /pubsub/publish              { channel, message } → { delivered }
 *   GET  /pubsub/:channel/stream      Exact-channel SSE stream
 *   GET  /pubsub/p/:pattern/stream    Pattern SSE stream (PSUBSCRIBE)
 *   GET  /pubsub/channels?pattern=*   PUBSUB CHANNELS — exact channels (tenant-scoped)
 *   POST /pubsub/numsub               { channels: string[] } → Record<channel, count>
 *   GET  /pubsub/numpat               PUBSUB NUMPAT — # of distinct patterns
 *
 * Tenant scoping
 * --------------
 *   - All channel/pattern names are prefixed with `${tenantId}:` before
 *     hitting the service. A tenant cannot publish into another tenant's
 *     channel, nor can a pattern subscribe match foreign channels.
 *   - On the way out, `channels` and `numsub` strip the prefix so clients
 *     never see other tenants' raw keys, and only see channels in their
 *     own namespace.
 */

import { Router } from "express";
import type { PubSubService } from "../../services/PubSub.js";
import { getTenantKey } from "../middleware/auth.js";

/**
 * Build a tenant-scoped pattern matcher used by PUBSUB CHANNELS:
 *   - The user's pattern (default `*`) is prepended with `${tenantId}:`.
 *   - On output, the prefix is stripped so the client sees plain channel names.
 *   - Foreign channels can never appear because the prefix is anchored.
 */
function buildChannelFilter(tenantId: string, raw: string | undefined) {
	const pattern = raw && raw.length > 0 ? raw : "*";
	const prefixed = `${tenantId}:${pattern}`;
	const prefix = `${tenantId}:`;
	return {
		pattern: prefixed,
		strip: (channel: string) =>
			channel.startsWith(prefix) ? channel.slice(prefix.length) : channel,
	};
}

export const createPubSubRoutes = (pubsub: PubSubService) => {
	const router = Router();

	// ── PUBLISH ──────────────────────────────────────────────────────────────

	/** Publish a message to a channel. */
	router.post("/publish", (req, res) => {
		const { channel, message } = req.body;
		if (typeof channel !== "string" || channel.length === 0) {
			return res.status(400).json({ error: "channel is required" });
		}
		const tenantChannel = getTenantKey(req.tenantId, channel);
		const delivered = pubsub.publish(tenantChannel, message);
		res.json({ success: true, delivered });
	});

	// ── PUBSUB introspection ─────────────────────────────────────────────────

	/**
	 * List exact-subscriber channels in the calling tenant's namespace.
	 * Optional glob `pattern` query (defaults to `*`).
	 */
	router.get("/channels", (req, res) => {
		const filter = buildChannelFilter(
			req.tenantId,
			req.query.pattern as string,
		);
		const all = pubsub.listChannels(filter.pattern);
		res.json({ channels: all.map(filter.strip) });
	});

	/**
	 * Per-channel exact subscriber counts.
	 * POST so callers can pass an array of channel names without URL-encoding.
	 */
	router.post("/numsub", (req, res) => {
		const { channels } = req.body;
		if (
			!Array.isArray(channels) ||
			channels.some((c) => typeof c !== "string")
		) {
			return res.status(400).json({ error: "channels must be string[]" });
		}
		const tenantChannels = (channels as string[]).map((c) =>
			getTenantKey(req.tenantId, c),
		);
		const counts = pubsub.numSub(tenantChannels);
		// Strip the tenant prefix from output keys.
		const prefix = `${req.tenantId}:`;
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(counts)) {
			out[k.startsWith(prefix) ? k.slice(prefix.length) : k] = v;
		}
		res.json({ counts: out });
	});

	/** Number of distinct patterns currently registered (server-wide). */
	router.get("/numpat", (_req, res) => {
		res.json({ count: pubsub.numPat() });
	});

	// ── SSE streams ──────────────────────────────────────────────────────────

	/**
	 * Exact-channel subscription via Server-Sent Events.
	 *
	 * GET /pubsub/:channel/stream
	 *
	 * The client connects once and receives every message published to
	 * `channel` until the connection closes.
	 */
	router.get("/:channel/stream", (req, res) => {
		const { channel } = req.params;
		const tenantChannel = getTenantKey(req.tenantId, channel);

		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no"); // prevent Nginx from buffering
		res.flushHeaders();

		const keepAlive = setInterval(() => res.write(": ping\n\n"), 30_000);

		const handler = (message: unknown) => {
			res.write(`data: ${JSON.stringify(message)}\n\n`);
		};

		pubsub.subscribe(tenantChannel, handler);

		req.on("close", () => {
			clearInterval(keepAlive);
			pubsub.unsubscribe(tenantChannel, handler);
		});
	});

	/**
	 * Pattern subscription via Server-Sent Events (PSUBSCRIBE).
	 *
	 * GET /pubsub/p/:pattern/stream
	 *
	 * Each event payload is `{ channel, message }` so subscribers can tell
	 * which channel triggered the message — that's what makes pattern
	 * subscriptions useful for fan-in routing.
	 *
	 * The pattern is scoped to the calling tenant: `${tenantId}:${pattern}`.
	 */
	router.get("/p/:pattern/stream", (req, res) => {
		const tenantPattern = getTenantKey(req.tenantId, req.params.pattern);
		const prefix = `${req.tenantId}:`;

		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no");
		res.flushHeaders();

		const keepAlive = setInterval(() => res.write(": ping\n\n"), 30_000);

		const handler = (message: unknown, channel: string) => {
			const out = {
				channel: channel.startsWith(prefix)
					? channel.slice(prefix.length)
					: channel,
				message,
			};
			res.write(`data: ${JSON.stringify(out)}\n\n`);
		};

		pubsub.psubscribe(tenantPattern, handler);

		req.on("close", () => {
			clearInterval(keepAlive);
			pubsub.punsubscribe(tenantPattern, handler);
		});
	});

	/**
	 * Legacy HTTP subscribe stub — kept for backwards compat with callers
	 * that hit `POST /pubsub/subscribe` before SSE was introduced.
	 */
	router.post("/subscribe", (req, res) => {
		const { channel } = req.body;
		const tenantChannel = getTenantKey(req.tenantId, channel);
		console.log(`[PubSub] Legacy subscribe request for ${tenantChannel}`);
		res.json({
			success: true,
			message: "Use GET /pubsub/:channel/stream for real-time delivery",
		});
	});

	return router;
};

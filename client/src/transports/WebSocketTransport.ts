/**
 * @file WebSocketTransport.ts
 * @module ErixClient/Transports/WebSocket
 *
 * WebSocket transport for @ecodrix/erix-client.
 *
 * Provides persistent binary (MessagePack) communication with erix-store,
 * supporting request/response multiplexing via correlation IDs, pipeline
 * batching, automatic reconnection with exponential backoff, and request
 * buffering during disconnection.
 */

import { pack, unpack } from "msgpackr";
import WebSocket from "ws";
import type { TransportLayer } from "./TransportLayer.js";

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface TransportOptions {
	/** WebSocket URL, e.g. ws://localhost:9876 */
	url: string;
	/** Headers to send on connection (auth, tenant) */
	headers: Record<string, string>;
	/** Request timeout in milliseconds (default: 5000) */
	timeoutMs?: number;
	/** Reconnection options */
	reconnect?: {
		/** Initial delay before first reconnect attempt (default: 1000) */
		initialDelayMs?: number;
		/** Maximum delay between reconnect attempts (default: 30000) */
		maxDelayMs?: number;
		/** Backoff multiplier (default: 2) */
		backoffFactor?: number;
	};
}

interface PendingRequest {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

interface BufferedRequest {
	frame: Buffer;
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
}

/** Frame sent to the server for a single request */
interface WsFrame {
	id: number;
	method: string;
	path: string;
	body?: unknown;
	params?: Record<string, string>;
}

/** Response from the server for a single request */
interface WsResponse {
	id: number;
	status: number;
	data: unknown;
}

/** Pipeline request frame */
interface WsPipelineFrame {
	id: number;
	pipeline: true;
	requests: WsFrame[];
}

/** Pipeline response frame */
interface WsPipelineResponse {
	id: number;
	pipeline: true;
	responses: WsResponse[];
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class TimeoutError extends Error {
	constructor(id: number, timeoutMs: number) {
		super(`Request ${id} timed out after ${timeoutMs}ms`);
		this.name = "TimeoutError";
	}
}

export class ConnectionLostError extends Error {
	constructor() {
		super("WebSocket connection lost");
		this.name = "ConnectionLostError";
	}
}

export class TransportClosedError extends Error {
	constructor() {
		super("WebSocket transport has been closed");
		this.name = "TransportClosedError";
	}
}

// ─── WebSocketTransport ─────────────────────────────────────────────────────

export class WebSocketTransport implements TransportLayer {
	private ws: WebSocket | null = null;
	private pending: Map<number, PendingRequest> = new Map();
	private buffer: BufferedRequest[] = [];
	private nextId = 1;
	private connected = false;
	private closed = false;
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	private readonly url: string;
	private readonly headers: Record<string, string>;
	private readonly timeoutMs: number;
	private readonly initialDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly backoffFactor: number;

	constructor(options: TransportOptions) {
		this.url = options.url;
		this.headers = options.headers;
		this.timeoutMs = options.timeoutMs ?? 5000;
		this.initialDelayMs = options.reconnect?.initialDelayMs ?? 1000;
		this.maxDelayMs = options.reconnect?.maxDelayMs ?? 30000;
		this.backoffFactor = options.reconnect?.backoffFactor ?? 2;

		this.connect();
	}

	// ─── Public API ─────────────────────────────────────────────────────────

	/**
	 * Send a request and await the correlated response.
	 * If disconnected, the request is buffered and replayed on reconnect.
	 */
	request(
		method: string,
		path: string,
		body?: unknown,
		params?: Record<string, string>,
	): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(new TransportClosedError());
		}

		const id = this.nextId++;
		const frame: WsFrame = { id, method, path };
		if (body !== undefined) frame.body = body;
		if (params !== undefined) frame.params = params;

		const encoded = pack(frame);

		return new Promise<unknown>((resolve, reject) => {
			if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
				this.registerPending(id, resolve, reject);
				this.ws.send(encoded);
			} else {
				// Buffer for replay on reconnect
				this.buffer.push({ frame: encoded, resolve, reject });
			}
		});
	}

	/**
	 * Send a pipeline batch and await all responses.
	 * All operations are sent in a single frame and resolved together.
	 */
	pipeline(
		requests: Array<{
			method: string;
			path: string;
			body?: unknown;
			params?: Record<string, string>;
		}>,
	): Promise<unknown[]> {
		if (this.closed) {
			return Promise.reject(new TransportClosedError());
		}

		const pipelineId = this.nextId++;
		const subRequests: WsFrame[] = requests.map((r) => {
			const subId = this.nextId++;
			const frame: WsFrame = { id: subId, method: r.method, path: r.path };
			if (r.body !== undefined) frame.body = r.body;
			if (r.params !== undefined) frame.params = r.params;
			return frame;
		});

		const pipelineFrame: WsPipelineFrame = {
			id: pipelineId,
			pipeline: true,
			requests: subRequests,
		};

		const encoded = pack(pipelineFrame);

		return new Promise<unknown[]>((resolve, reject) => {
			if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
				this.registerPipelinePending(pipelineId, resolve, reject);
				this.ws.send(encoded);
			} else {
				// Buffer pipeline request — wrap resolve/reject to handle pipeline response
				const wrappedResolve = (data: unknown) => {
					const pipelineResp = data as WsPipelineResponse;
					resolve(pipelineResp.responses.map((r) => r.data));
				};
				this.buffer.push({ frame: encoded, resolve: wrappedResolve, reject });
			}
		});
	}

	/**
	 * Close the transport. Rejects all pending requests, clears timers,
	 * and closes the WebSocket connection.
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;

		// Clear reconnect timer
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		// Reject all pending requests
		const closedError = new TransportClosedError();
		for (const [_id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(closedError);
		}
		this.pending.clear();

		// Reject all buffered requests
		for (const buffered of this.buffer) {
			buffered.reject(closedError);
		}
		this.buffer = [];

		// Close WebSocket
		if (this.ws) {
			this.ws.removeAllListeners();
			if (
				this.ws.readyState === WebSocket.OPEN ||
				this.ws.readyState === WebSocket.CONNECTING
			) {
				this.ws.close(1000, "Client closing");
			}
			this.ws = null;
		}

		this.connected = false;
	}

	/**
	 * Returns whether the transport is currently connected.
	 */
	get isConnected(): boolean {
		return this.connected;
	}

	// ─── Connection Management ──────────────────────────────────────────────

	private connect(): void {
		if (this.closed) return;

		this.ws = new WebSocket(this.url, {
			headers: this.headers,
		});

		this.ws.binaryType = "nodebuffer";

		this.ws.on("open", () => {
			this.connected = true;
			this.reconnectAttempt = 0;
			this.replayBuffer();
		});

		this.ws.on("message", (data: Buffer) => {
			this.handleMessage(data);
		});

		this.ws.on("close", () => {
			this.handleDisconnect();
		});

		this.ws.on("error", () => {
			// Error is followed by close event, so we handle reconnect there
		});
	}

	private handleDisconnect(): void {
		this.connected = false;

		if (this.closed) return;

		// Reject pending requests that were in-flight (they won't get responses)
		const lostError = new ConnectionLostError();
		for (const [_id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(lostError);
		}
		this.pending.clear();

		// Schedule reconnect with exponential backoff
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.closed) return;

		const delay = Math.min(
			this.initialDelayMs * this.backoffFactor ** this.reconnectAttempt,
			this.maxDelayMs,
		);
		this.reconnectAttempt++;

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	// ─── Buffer Replay ──────────────────────────────────────────────────────

	private replayBuffer(): void {
		const buffered = this.buffer.splice(0);
		for (const entry of buffered) {
			if (this.closed) {
				entry.reject(new TransportClosedError());
				continue;
			}

			// Decode the frame to get the ID for pending registration
			const decoded = unpack(entry.frame) as WsFrame | WsPipelineFrame;

			if ("pipeline" in decoded && decoded.pipeline) {
				// Pipeline frame
				const _pipelineResolve = (data: unknown) => {
					const resp = data as WsPipelineResponse;
					entry.resolve(resp);
				};
				this.registerPipelinePending(
					decoded.id,
					(responses: unknown[]) => {
						entry.resolve(responses);
					},
					entry.reject,
				);
				this.ws?.send(entry.frame);
			} else {
				// Single request frame
				this.registerPending(decoded.id, entry.resolve, entry.reject);
				this.ws?.send(entry.frame);
			}
		}
	}

	// ─── Message Handling ───────────────────────────────────────────────────

	private handleMessage(data: Buffer): void {
		let decoded: unknown;
		try {
			decoded = unpack(data);
		} catch {
			// Malformed response — ignore
			return;
		}

		if (typeof decoded !== "object" || decoded === null) return;

		const msg = decoded as Record<string, unknown>;

		// Check if it's a pipeline response
		if (msg.pipeline === true && Array.isArray(msg.responses)) {
			const pipelineResp = msg as unknown as WsPipelineResponse;
			const pending = this.pending.get(pipelineResp.id);
			if (pending) {
				clearTimeout(pending.timeout);
				this.pending.delete(pipelineResp.id);
				pending.resolve(pipelineResp.responses.map((r) => r.data));
			}
			return;
		}

		// Single response
		const response = msg as unknown as WsResponse;
		if (typeof response.id !== "number") return;

		const pending = this.pending.get(response.id);
		if (pending) {
			clearTimeout(pending.timeout);
			this.pending.delete(response.id);

			if (response.status >= 400) {
				const errData = response.data as { error?: string } | undefined;
				const errMsg =
					typeof errData === "object" && errData?.error
						? errData.error
						: `Request failed with status ${response.status}`;
				pending.reject(new Error(errMsg));
			} else {
				pending.resolve(response.data);
			}
		}
	}

	// ─── Pending Request Registration ──────────────────────────────────────

	private registerPending(
		id: number,
		resolve: (data: unknown) => void,
		reject: (err: Error) => void,
	): void {
		const timeout = setTimeout(() => {
			this.pending.delete(id);
			reject(new TimeoutError(id, this.timeoutMs));
		}, this.timeoutMs);

		this.pending.set(id, { resolve, reject, timeout });
	}

	private registerPipelinePending(
		id: number,
		resolve: (data: unknown[]) => void,
		reject: (err: Error) => void,
	): void {
		const timeout = setTimeout(() => {
			this.pending.delete(id);
			reject(new TimeoutError(id, this.timeoutMs));
		}, this.timeoutMs);

		// Store with a wrapped resolve that handles the pipeline response format
		this.pending.set(id, {
			resolve: resolve as (data: unknown) => void,
			reject,
			timeout,
		});
	}
}

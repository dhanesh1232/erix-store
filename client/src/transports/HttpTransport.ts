/**
 * @file HttpTransport.ts
 * @module ErixClient/Transports/HttpTransport
 *
 * HTTP transport for @ecodrix/erix-client.
 *
 * Wraps the existing fetch-based request logic into a TransportLayer
 * implementation. This is the default/fallback transport that preserves
 * the original behavior of the client.
 */

import type { TransportLayer } from "./TransportLayer.js";

export interface HttpTransportOptions {
	/** Full base URL of the erix-store instance */
	baseUrl: string;
	/** Headers to include on every request (auth, tenant, content-type) */
	headers: Record<string, string>;
	/** Request timeout in milliseconds (default: 5000) */
	timeoutMs?: number;
}

export class HttpTransport implements TransportLayer {
	private readonly baseUrl: string;
	private readonly headers: Record<string, string>;
	private readonly timeoutMs: number;
	private closed = false;

	constructor(options: HttpTransportOptions) {
		this.baseUrl = options.baseUrl;
		this.headers = options.headers;
		this.timeoutMs = options.timeoutMs ?? 5000;
	}

	/**
	 * HTTP is always "connected" — each request is independent.
	 */
	get isConnected(): boolean {
		return !this.closed;
	}

	/**
	 * Send a single HTTP request using native fetch.
	 */
	async request(
		method: string,
		path: string,
		body?: unknown,
		params?: Record<string, string>,
	): Promise<unknown> {
		if (this.closed) {
			throw new Error("[erix-store] HttpTransport has been closed");
		}

		const url = new URL(`${this.baseUrl}${path}`);
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				url.searchParams.set(k, v);
			}
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			const res = await fetch(url.toString(), {
				method,
				headers: this.headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});

			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(
					`[erix-store] ${method} ${path} → ${res.status}: ${err.error ?? res.statusText}`,
				);
			}

			return await res.json();
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Pipeline over HTTP — executes requests sequentially since HTTP
	 * doesn't natively support multiplexing in a single connection.
	 * Still provides the same API contract as WebSocket pipeline.
	 */
	async pipeline(
		requests: Array<{
			method: string;
			path: string;
			body?: unknown;
			params?: Record<string, string>;
		}>,
	): Promise<unknown[]> {
		// Execute all requests concurrently via Promise.all
		return Promise.all(
			requests.map((r) => this.request(r.method, r.path, r.body, r.params)),
		);
	}

	/**
	 * Mark the transport as closed. Subsequent requests will throw.
	 */
	close(): void {
		this.closed = true;
	}
}

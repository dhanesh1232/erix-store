/**
 * @file TransportLayer.ts
 * @module ErixClient/Transports/TransportLayer
 *
 * Strategy interface for erix-client transports.
 * Both HttpTransport and WebSocketTransport implement this interface,
 * allowing the ErixClient to swap transports transparently.
 */

/**
 * Common interface that all transport implementations must satisfy.
 * Provides request/response semantics regardless of underlying protocol.
 */
export interface TransportLayer {
	/**
	 * Send a request and await the response.
	 * @param method HTTP-like method (GET, POST, DELETE, PATCH)
	 * @param path   Route path (e.g. /core/get, /queue/v2/jobs)
	 * @param body   Optional request body
	 * @param params Optional query parameters
	 */
	request(
		method: string,
		path: string,
		body?: unknown,
		params?: Record<string, string>,
	): Promise<unknown>;

	/**
	 * Send a batch of requests as a single round-trip (pipeline).
	 * Returns an array of results in the same order as the input requests.
	 */
	pipeline(
		requests: Array<{
			method: string;
			path: string;
			body?: unknown;
			params?: Record<string, string>;
		}>,
	): Promise<unknown[]>;

	/**
	 * Close the transport and release resources.
	 */
	close(): void;

	/**
	 * Whether the transport is currently connected/ready.
	 */
	readonly isConnected: boolean;
}

/** Transport mode option for ErixClient */
export type TransportMode = "http" | "ws" | "auto";

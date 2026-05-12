/**
 * @file ws.ts
 * @module ErixStore/Server/WebSocket
 *
 * WebSocket transport layer for erix-store.
 *
 * Attaches a `ws` WebSocketServer to an existing HTTP server (same port).
 * Incoming binary frames are decoded from MessagePack, routed through the
 * provided route handler, and responses are encoded back to MessagePack
 * with matching correlation IDs.
 *
 * Supports:
 *   - Single request frames
 *   - Pipeline batch frames (array of requests → array of responses)
 *   - Malformed frame handling (status 400, connection kept open)
 */

import type { Server as HttpServer } from "node:http";
import { pack, unpack } from "msgpackr";
import { type WebSocket, WebSocketServer } from "ws";

// ─── Frame Interfaces ──────────────────────────────────────────────────────────

export interface WsFrame {
	/** Correlation ID for request/response matching */
	id: number;
	/** HTTP-like method: GET, POST, DELETE, PATCH */
	method: string;
	/** Route path: /core/get, /queue/v2/jobs, etc. */
	path: string;
	/** Request body (optional) */
	body?: unknown;
	/** Query params (optional) */
	params?: Record<string, string>;
}

export interface WsResponse {
	/** Correlation ID matching the request */
	id: number;
	/** HTTP status code equivalent */
	status: number;
	/** Response body */
	data: unknown;
}

export interface WsPipelineFrame {
	/** Pipeline batch ID */
	id: number;
	/** Flag indicating this is a pipeline batch */
	pipeline: true;
	/** Array of individual requests */
	requests: WsFrame[];
}

export interface WsPipelineResponse {
	id: number;
	pipeline: true;
	responses: WsResponse[];
}

// ─── Route Handler Type ────────────────────────────────────────────────────────

/**
 * A route handler function that processes a request and returns a response.
 * This is the same logic used by HTTP routes, abstracted for reuse.
 */
export type RouteHandler = (
	method: string,
	path: string,
	body?: unknown,
	params?: Record<string, string>,
) => Promise<{ status: number; data: unknown }>;

// ─── Frame Validation ──────────────────────────────────────────────────────────

function isValidFrame(frame: unknown): frame is WsFrame {
	if (typeof frame !== "object" || frame === null) return false;
	const f = frame as Record<string, unknown>;
	return (
		typeof f.id === "number" &&
		typeof f.method === "string" &&
		typeof f.path === "string"
	);
}

function isPipelineFrame(frame: unknown): frame is WsPipelineFrame {
	if (typeof frame !== "object" || frame === null) return false;
	const f = frame as Record<string, unknown>;
	return (
		typeof f.id === "number" && f.pipeline === true && Array.isArray(f.requests)
	);
}

// ─── WebSocket Server ──────────────────────────────────────────────────────────

/**
 * Attaches a WebSocket server to an existing HTTP server.
 *
 * The WebSocket server handles the HTTP upgrade event and processes
 * binary MessagePack frames, routing them through the provided handler.
 *
 * @param server - The HTTP server to attach to (same port)
 * @param routeHandler - Function that routes requests (same logic as HTTP routes)
 * @returns The WebSocketServer instance
 */
export function attachWebSocket(
	server: HttpServer,
	routeHandler: RouteHandler,
): WebSocketServer {
	const wss = new WebSocketServer({ server });

	wss.on("connection", (ws: WebSocket) => {
		ws.on(
			"message",
			(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
				void handleMessage(ws, data, isBinary, routeHandler);
			},
		);
	});

	return wss;
}

/**
 * Handles an incoming WebSocket message.
 * Decodes from MessagePack, validates, routes, and sends response.
 */
async function handleMessage(
	ws: WebSocket,
	data: Buffer | ArrayBuffer | Buffer[],
	_isBinary: boolean,
	routeHandler: RouteHandler,
): Promise<void> {
	// Convert to Buffer for msgpackr
	let buffer: Buffer;
	if (Buffer.isBuffer(data)) {
		buffer = data;
	} else if (data instanceof ArrayBuffer) {
		buffer = Buffer.from(data);
	} else {
		// Buffer[] — concatenate
		buffer = Buffer.concat(data);
	}

	// Attempt to decode the MessagePack frame
	let decoded: unknown;
	try {
		decoded = unpack(buffer);
	} catch {
		// Malformed MessagePack — send error with id 0 (no correlation possible)
		const errorResponse: WsResponse = {
			id: 0,
			status: 400,
			data: { error: "Invalid MessagePack frame" },
		};
		sendResponse(ws, errorResponse);
		return;
	}

	// Check if it's a pipeline frame
	if (isPipelineFrame(decoded)) {
		await handlePipeline(ws, decoded, routeHandler);
		return;
	}

	// Check if it's a single request frame
	if (isValidFrame(decoded)) {
		await handleSingleRequest(ws, decoded, routeHandler);
		return;
	}

	// Decoded successfully but not a valid frame structure
	const id =
		typeof decoded === "object" && decoded !== null && "id" in decoded
			? (decoded as Record<string, unknown>).id
			: 0;
	const errorResponse: WsResponse = {
		id: typeof id === "number" ? id : 0,
		status: 400,
		data: { error: "Invalid frame format" },
	};
	sendResponse(ws, errorResponse);
}

/**
 * Handles a single request frame.
 */
async function handleSingleRequest(
	ws: WebSocket,
	frame: WsFrame,
	routeHandler: RouteHandler,
): Promise<void> {
	try {
		const result = await routeHandler(
			frame.method,
			frame.path,
			frame.body,
			frame.params,
		);
		const response: WsResponse = {
			id: frame.id,
			status: result.status,
			data: result.data,
		};
		sendResponse(ws, response);
	} catch (err: unknown) {
		const response: WsResponse = {
			id: frame.id,
			status: 500,
			data: {
				error: err instanceof Error ? err.message : "Internal server error",
			},
		};
		sendResponse(ws, response);
	}
}

/**
 * Handles a pipeline batch frame.
 * Processes all requests concurrently and returns all responses.
 */
async function handlePipeline(
	ws: WebSocket,
	frame: WsPipelineFrame,
	routeHandler: RouteHandler,
): Promise<void> {
	// Validate each request in the pipeline
	const invalidIndex = frame.requests.findIndex((r) => !isValidFrame(r));
	if (invalidIndex !== -1) {
		const errorResponse: WsResponse = {
			id: frame.id,
			status: 400,
			data: { error: `Invalid request at pipeline index ${invalidIndex}` },
		};
		sendResponse(ws, errorResponse);
		return;
	}

	// Process all requests concurrently
	const responses = await Promise.all(
		frame.requests.map(async (req): Promise<WsResponse> => {
			try {
				const result = await routeHandler(
					req.method,
					req.path,
					req.body,
					req.params,
				);
				return {
					id: req.id,
					status: result.status,
					data: result.data,
				};
			} catch (err: unknown) {
				return {
					id: req.id,
					status: 500,
					data: {
						error: err instanceof Error ? err.message : "Internal server error",
					},
				};
			}
		}),
	);

	const pipelineResponse: WsPipelineResponse = {
		id: frame.id,
		pipeline: true,
		responses,
	};
	sendPipelineResponse(ws, pipelineResponse);
}

/**
 * Encodes and sends a response via WebSocket as a binary MessagePack frame.
 */
function sendResponse(ws: WebSocket, response: WsResponse): void {
	if (ws.readyState === ws.OPEN) {
		ws.send(pack(response));
	}
}

/**
 * Encodes and sends a pipeline response via WebSocket as a binary MessagePack frame.
 */
function sendPipelineResponse(
	ws: WebSocket,
	response: WsPipelineResponse,
): void {
	if (ws.readyState === ws.OPEN) {
		ws.send(pack(response));
	}
}

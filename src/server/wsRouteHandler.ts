/**
 * @file wsRouteHandler.ts
 * @module ErixStore/Server/WsRouteHandler
 *
 * Creates a RouteHandler function that bridges WebSocket frames to the
 * Express application's route logic. Uses synthetic IncomingMessage/ServerResponse
 * objects to pass requests through Express's middleware stack (auth, metering, routes)
 * without opening a real HTTP connection.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { Express, Request, Response } from "express";
import type { RouteHandler } from "./ws.js";

/** Type for chunk data in response write/end methods */
type ResponseChunk = string | Buffer | Uint8Array;

/**
 * Creates a RouteHandler that routes WebSocket frames through the Express app.
 *
 * The handler constructs synthetic request/response objects and invokes
 * Express's internal request handling. This ensures WebSocket requests
 * pass through the same middleware (auth, metering) and route handlers
 * as HTTP requests.
 *
 * @param app - The Express application instance
 * @returns A RouteHandler compatible with attachWebSocket
 */
export function createRouteHandler(app: Express): RouteHandler {
	return async (
		method: string,
		path: string,
		body?: unknown,
		params?: Record<string, string>,
	): Promise<{ status: number; data: unknown }> => {
		return new Promise((resolve) => {
			// Build query string from params
			const queryString = params
				? `?${new URLSearchParams(params).toString()}`
				: "";
			const url = `${path}${queryString}`;

			// Create a minimal socket (not connected to anything)
			const socket = new Socket();

			// Create synthetic IncomingMessage
			const req = new IncomingMessage(socket);
			req.method = method.toUpperCase();
			req.url = url;
			req.headers = {
				"content-type": "application/json",
				// WebSocket connections are pre-authenticated at connection time,
				// so we inject the auth headers to pass through Express middleware.
				// In a production setup, auth would be handled at WS upgrade time
				// and tenantId would be attached to the connection.
				"x-erix-key": process.env.ERIX_API_KEY ?? "",
				"x-tenant-id": params?.["x-tenant-id"] ?? "ws-default",
			};

			// If there's a body, we need to make it readable
			if (body !== undefined && body !== null) {
				const bodyStr = JSON.stringify(body);
				req.headers["content-length"] = Buffer.byteLength(bodyStr).toString();
				// Push body data into the readable stream
				req.push(bodyStr);
				req.push(null); // Signal end of stream
			} else {
				req.headers["content-length"] = "0";
				req.push(null);
			}

			// Create synthetic ServerResponse
			const res = new ServerResponse(req);

			// Capture the response data
			let responseBody = "";
			let statusCode = 200;

			res.write = ((chunk: ResponseChunk, ..._args: unknown[]): boolean => {
				if (chunk) {
					responseBody += typeof chunk === "string" ? chunk : chunk.toString();
				}
				return true;
			}) as typeof res.write;

			res.end = ((
				chunk?: ResponseChunk,
				..._args: unknown[]
			): ServerResponse => {
				if (chunk) {
					responseBody += typeof chunk === "string" ? chunk : chunk.toString();
				}
				statusCode = res.statusCode;

				// Parse the response body
				let data: unknown;
				try {
					data = responseBody ? JSON.parse(responseBody) : null;
				} catch {
					data = responseBody || null;
				}

				// Clean up the socket
				socket.destroy();

				resolve({ status: statusCode, data });
				return res;
			}) as typeof res.end;

			// Route through Express (synthetic req/res are compatible with Express types)
			app(req as Request, res as Response);
		});
	};
}

/**
 * @file ws-server.test.ts
 * Unit tests for the WebSocket server attachment (src/server/ws.ts)
 */

import { createServer, type Server as HttpServer } from "node:http";
import { pack, unpack } from "msgpackr";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import WebSocket from "ws";
import {
	attachWebSocket,
	type RouteHandler,
	type WsFrame,
	type WsPipelineFrame,
} from "../../src/server/ws.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Response frame from WebSocket server */
interface WsResponse {
	id: number;
	status: number;
	data: {
		method?: string;
		path?: string;
		body?: unknown;
		params?: Record<string, string>;
		error?: string;
	};
	pipeline?: boolean;
	responses?: WsResponse[];
}

// ─── Test Helpers ──────────────────────────────────────────────────────────────

async function createTestServer(
	handler: RouteHandler,
): Promise<{ server: HttpServer; port: number; close: () => Promise<void> }> {
	const server = createServer();
	attachWebSocket(server, handler);

	const port = await new Promise<number>((resolve) => {
		server.listen(0, () => {
			const addr = server.address();
			if (addr && typeof addr === "object") {
				resolve(addr.port);
			}
		});
	});

	return {
		server,
		port,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

async function connectWs(port: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${port}`);
		ws.on("open", () => resolve(ws));
		ws.on("error", reject);
	});
}

function sendAndReceive(ws: WebSocket, frame: unknown): Promise<WsResponse> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("Timeout waiting for response")),
			5000,
		);
		ws.once("message", (data: Buffer) => {
			clearTimeout(timeout);
			resolve(unpack(data) as WsResponse);
		});
		ws.send(pack(frame));
	});
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("WebSocket Server (attachWebSocket)", () => {
	let testServer: Awaited<ReturnType<typeof createTestServer>>;
	let ws: WebSocket;

	const echoHandler: RouteHandler = async (method, path, body, params) => {
		return {
			status: 200,
			data: { method, path, body, params },
		};
	};

	beforeAll(async () => {
		testServer = await createTestServer(echoHandler);
	});

	afterAll(async () => {
		await testServer.close();
	});

	beforeEach(async () => {
		ws = await connectWs(testServer.port);
	});

	afterEach(() => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.close();
		}
	});

	describe("Single request frames", () => {
		it("should decode a MessagePack frame and return response with matching correlation ID", async () => {
			const frame: WsFrame = {
				id: 42,
				method: "GET",
				path: "/core/get",
				params: { key: "hello" },
			};

			const response = await sendAndReceive(ws, frame);

			expect(response.id).toBe(42);
			expect(response.status).toBe(200);
			expect(response.data.method).toBe("GET");
			expect(response.data.path).toBe("/core/get");
			expect(response.data.params).toEqual({ key: "hello" });
		});

		it("should pass body through to the route handler", async () => {
			const frame: WsFrame = {
				id: 1,
				method: "POST",
				path: "/core/set",
				body: { key: "foo", value: "bar", ttl: 60 },
			};

			const response = await sendAndReceive(ws, frame);

			expect(response.id).toBe(1);
			expect(response.status).toBe(200);
			expect(response.data.body).toEqual({ key: "foo", value: "bar", ttl: 60 });
		});

		it("should handle multiple sequential requests with correct correlation IDs", async () => {
			const frames: WsFrame[] = [
				{ id: 1, method: "GET", path: "/core/get", params: { key: "a" } },
				{
					id: 2,
					method: "POST",
					path: "/core/set",
					body: { key: "b", value: "v" },
				},
				{ id: 3, method: "DELETE", path: "/core/del", body: { key: "c" } },
			];

			for (const frame of frames) {
				const response = await sendAndReceive(ws, frame);
				expect(response.id).toBe(frame.id);
				expect(response.status).toBe(200);
			}
		});
	});

	describe("Pipeline batch frames", () => {
		it("should process a pipeline frame and return all responses", async () => {
			const pipeline: WsPipelineFrame = {
				id: 100,
				pipeline: true,
				requests: [
					{ id: 1, method: "GET", path: "/core/get", params: { key: "x" } },
					{
						id: 2,
						method: "POST",
						path: "/core/set",
						body: { key: "y", value: "z" },
					},
				],
			};

			const response = await sendAndReceive(ws, pipeline);

			expect(response.id).toBe(100);
			expect(response.pipeline).toBe(true);
			expect(response.responses).toHaveLength(2);
			expect(response.responses?.[0].id).toBe(1);
			expect(response.responses?.[0].status).toBe(200);
			expect(response.responses?.[1].id).toBe(2);
			expect(response.responses?.[1].status).toBe(200);
		});

		it("should return 400 for pipeline with invalid requests", async () => {
			const pipeline = {
				id: 200,
				pipeline: true,
				requests: [
					{ id: 1, method: "GET", path: "/core/get" },
					{ method: "POST", path: "/core/set" }, // missing id
				],
			};

			const response = await sendAndReceive(ws, pipeline);

			expect(response.id).toBe(200);
			expect(response.status).toBe(400);
			expect(response.data.error).toContain(
				"Invalid request at pipeline index",
			);
		});
	});

	describe("Malformed frames", () => {
		it("should return 400 for invalid MessagePack data", async () => {
			return new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
				ws.once("message", (data: Buffer) => {
					clearTimeout(timeout);
					const response = unpack(data) as WsResponse;
					expect(response.id).toBe(0);
					expect(response.status).toBe(400);
					expect(response.data.error).toBe("Invalid MessagePack frame");
					resolve();
				});
				// Send garbage binary data that isn't valid MessagePack
				ws.send(Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb]));
			});
		});

		it("should return 400 for decoded data missing required fields", async () => {
			const invalidFrame = { id: 99, foo: "bar" }; // missing method and path

			const response = await sendAndReceive(ws, invalidFrame);

			expect(response.id).toBe(99);
			expect(response.status).toBe(400);
			expect(response.data.error).toBe("Invalid frame format");
		});

		it("should keep connection open after malformed frame", async () => {
			// Send malformed frame
			const invalidFrame = { id: 1, foo: "bar" };
			await sendAndReceive(ws, invalidFrame);

			// Connection should still be open — send a valid frame
			const validFrame: WsFrame = { id: 2, method: "GET", path: "/test" };
			const response = await sendAndReceive(ws, validFrame);

			expect(response.id).toBe(2);
			expect(response.status).toBe(200);
		});
	});

	describe("Error handling in route handler", () => {
		it("should return 500 when route handler throws", async () => {
			const errorServer = await createTestServer(async () => {
				throw new Error("Something went wrong");
			});

			const errorWs = await connectWs(errorServer.port);

			try {
				const frame: WsFrame = { id: 5, method: "GET", path: "/fail" };
				const response = await sendAndReceive(errorWs, frame);

				expect(response.id).toBe(5);
				expect(response.status).toBe(500);
				expect(response.data.error).toBe("Something went wrong");
			} finally {
				errorWs.close();
				await errorServer.close();
			}
		});
	});
});

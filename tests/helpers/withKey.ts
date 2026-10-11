/**
 * @file withKey.ts
 *
 * Wraps a WebSocket route handler so every call carries `x-erix-key`, the way
 * a real client does. The handler never falls back to a server env key.
 */

import type { createRouteHandler } from "../../src/server/wsRouteHandler.js";

type Handler = ReturnType<typeof createRouteHandler>;

export function withKey(handler: Handler, key: string): Handler {
	return (method, path, body, params, auth) =>
		handler(method, path, body, { "x-erix-key": key, ...params }, auth);
}

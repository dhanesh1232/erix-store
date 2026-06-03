/**
 * @file errors.ts
 * @module Core/Errors
 *
 * Domain-specific error types for ErixStore.
 *
 * These errors are translated to HTTP responses by the global
 * Express error handler in `server/app.ts`. They are also caught
 * by the WebSocket route bridge when a frame produces them.
 */

/**
 * Thrown when an operation targets a key that exists with a different data
 * type than the operation expects.
 *
 * Mirrors the standard WRONGTYPE error verbatim:
 *   "WRONGTYPE Operation against a key holding the wrong kind of value"
 *
 * Surfaced as HTTP 409 with `{ error: <message> }`.
 */
export class WrongTypeError extends Error {
  public readonly code = "WRONGTYPE" as const;

  constructor(
    message = "WRONGTYPE Operation against a key holding the wrong kind of value",
  ) {
    super(message);
    this.name = "WrongTypeError";
    // Preserve prototype chain for instanceof checks across module boundaries
    Object.setPrototypeOf(this, WrongTypeError.prototype);
  }
}

/**
 * Thrown when a write would push memory past `maxmemory` and the active
 * eviction policy cannot free enough space (either policy is `noeviction`
 * or all eligible keys have been evicted and the cap is still exceeded).
 *
 * Mirrors the standard OOM error message:
 *   "OOM command not allowed when used memory > 'maxmemory'"
 *
 * Surfaced as HTTP 507 (Insufficient Storage).
 */
export class OOMError extends Error {
  public readonly code = "OOM" as const;

  constructor(
    message = "OOM command not allowed when used memory > 'maxmemory'",
  ) {
    super(message);
    this.name = "OOMError";
    Object.setPrototypeOf(this, OOMError.prototype);
  }
}

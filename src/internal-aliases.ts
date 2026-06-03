/**
 * @file internal-aliases.ts
 * @module Internal/Aliases
 *
 * Smoke-test module proving that the project supports both:
 *
 *   1. The `@/*` path alias (resolved to `src/*`)
 *   2. Extensionless TypeScript imports (no `.ts` / `.js` suffix)
 *
 * Each of the imports below exercises one of the two styles. The build
 * pipeline (`tsc` + `tsc-alias`) rewrites `@/...` → relative paths and
 * stamps `.js` extensions, so the compiled dist is plain Node-ESM
 * compatible. The test runner (Vitest with vite-tsconfig-paths) and
 * the dev runner (tsx) both resolve them natively.
 *
 * Re-exports a tiny mixed bag of types and values so callers can import
 * any of them through a single entry point and `tsc --noEmit` confirms
 * the resolution at compile time.
 */

// Style A: alias + extensionless
import { globToRegExp } from "@/server/glob";
import type { ErixType } from "@/core/TypeRegistry";

// Style B: relative + extensionless (still legal under Bundler resolution)
import { WrongTypeError } from "./core/errors";

// Style C: classic relative + .js (the existing project default)
import { TypeRegistry } from "./core/TypeRegistry.js";

export { globToRegExp, WrongTypeError, TypeRegistry };
export type { ErixType };

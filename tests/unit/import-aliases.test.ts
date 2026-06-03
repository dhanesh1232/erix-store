/**
 * @file import-aliases.test.ts
 *
 * Smoke test for the `@/*` alias and extensionless TypeScript imports.
 *
 * If this file compiles and runs, the test toolchain (vitest +
 * vite-tsconfig-paths) is reading `tsconfig.json#paths` correctly and
 * the alias points at `src/`. The `expect`s themselves are intentionally
 * minimal — failing imports show up as a module-not-found at file load
 * time, long before any assertion runs.
 *
 * The same imports are also exercised by `src/internal-aliases.ts`,
 * which proves the production build path (tsc + tsc-alias) emits a
 * runnable dist. Together they guarantee:
 *
 *   - Type-check    → tsc --noEmit
 *   - Production    → tsc + tsc-alias → node dist/...
 *   - Tests         → vitest with the tsconfig-paths plugin
 *   - Dev runtime   → tsx (handles aliases natively)
 */

import { describe, expect, it } from "vitest";

// Style A: alias + extensionless.
import { globToRegExp } from "@/server/glob";
// Style B: alias + extensionless on a barrel module.
import { TypeRegistry, WrongTypeError } from "@/internal-aliases";
// Style C: relative + extensionless (Bundler resolution).
import { OOMError } from "../../src/core/errors";
// Style D: legacy relative + .js (still valid; not removed anywhere).
import { dispatchCommand } from "../../src/server/commands.js";

describe("path aliases and extensionless imports", () => {
  it("resolves @/<...> aliases at test time", () => {
    expect(typeof globToRegExp).toBe("function");
    expect(globToRegExp("foo*").test("foobar")).toBe(true);
  });

  it("resolves an aliased barrel that itself uses @/ + extensionless", () => {
    const reg = new TypeRegistry();
    reg.register("k", "string");
    expect(reg.getType("k")).toBe("string");

    expect(() => {
      throw new WrongTypeError();
    }).toThrow(WrongTypeError);
  });

  it("relative + extensionless imports work alongside alias imports", () => {
    expect(() => {
      throw new OOMError();
    }).toThrow(OOMError);
  });

  it("legacy relative + .js imports still work", () => {
    expect(typeof dispatchCommand).toBe("function");
  });
});

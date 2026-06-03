/**
 * @file glob.ts
 * @module Server/Glob
 *
 * POSIX-style glob → RegExp converter for the `KEYS` command.
 *
 * Supported syntax:
 *   *         — matches zero or more of any character
 *   ?         — matches exactly one character
 *   [abc]     — character class
 *   [^abc]    — negated character class
 *   [a-z]     — character range
 *   \\<char>  — escapes the next metacharacter (matches it literally)
 *
 * All other RegExp metacharacters are escaped automatically so the pattern
 * cannot inject regex behaviour unexpectedly.
 *
 * @requirements P0.4 — KEYS pattern
 */

const REGEX_META = /[.+*?^${}()|[\]\\]/;

/** Convert a POSIX-style glob pattern to a RegExp anchored to the full string. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      // Escape the next character literally
      const next = pattern[i + 1];
      out += REGEX_META.test(next) ? `\\${next}` : next;
      i += 2;
      continue;
    }
    if (ch === "*") {
      out += ".*";
      i++;
      continue;
    }
    if (ch === "?") {
      out += ".";
      i++;
      continue;
    }
    if (ch === "[") {
      // Character class — pass through; ranges and ^-negation parse the
      // same way in JS regex so we can emit them verbatim.
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        // Unclosed class — treat the [ literally
        out += "\\[";
        i++;
        continue;
      }
      const cls = pattern.slice(i + 1, close);
      out += `[${cls}]`;
      i = close + 1;
      continue;
    }
    // Default: escape regex meta, otherwise emit literally
    out += REGEX_META.test(ch) ? `\\${ch}` : ch;
    i++;
  }
  return new RegExp(`^${out}$`);
}

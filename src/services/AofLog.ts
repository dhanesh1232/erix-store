/**
 * @file AofLog.ts
 * @module Services/AofLog
 *
 * Append-only file for command-level durability.
 *
 * Why an AOF (when Postgres snapshots already exist)
 * ---------------------------------------------------
 * Snapshots run on a 5-minute interval. Anything written between two
 * snapshots is at risk of loss after a hard crash. The AOF closes that
 * window: every mutating command is appended (and optionally fsync'd)
 * before the dispatcher returns. After a restart, replaying the AOF
 * reconstructs the in-memory state exactly.
 *
 * Format
 * ------
 * One JSON object per line:
 *
 *   { "ts": <unix ms>, "tenantId": "<tid>", "name": "SET", "args": ["k","v"] }
 *
 * Lines are independent — a partial trailing line (a torn write) is
 * skipped during replay. We never abort replay on a single corrupt line;
 * we log it and move on so a single bad write can't render the database
 * unrecoverable.
 *
 * fsync policies
 * --------------
 *   - **always**   — fsync after every appended command. Strongest
 *                    durability; lowest throughput. Safe for hard kills.
 *   - **everysec** — fsync at most once per second. Lose up to 1s of
 *                    writes after a crash. Redis default.
 *   - **no**       — never fsync from the AOF; rely on OS flushing.
 *                    Cheapest; weakest durability.
 *
 * Rewrite
 * -------
 * When `BGREWRITEAOF` is invoked, we serialise the live in-memory state
 * to a temporary file, fsync it, and `rename(2)` it over the active log.
 * The atomic rename means crash recovery never sees a half-rewritten
 * AOF — either the old or the new file exists in full.
 *
 * @requirements P2.3 — local AOF
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** A single AOF entry — same shape used by the dispatcher's `Command`. */
export interface AofEntry {
  /** Unix epoch (ms) at which the command was logged. */
  ts: number;
  /** Tenant whose request produced this mutation. */
  tenantId: string;
  /** Verb name in upper-case. */
  name: string;
  /** Positional args, as supplied to the dispatcher. */
  args: unknown[];
}

export type FsyncPolicy = "always" | "everysec" | "no";

export interface AofLogOptions {
  /** Absolute path to the AOF file. Required to enable. */
  path: string;
  /** fsync policy. Default `everysec`. */
  fsyncPolicy?: FsyncPolicy;
}

const DEFAULT_FSYNC_POLICY: FsyncPolicy = "everysec";
const EVERYSEC_INTERVAL_MS = 1000;

export class AofLog {
  private fd: number;
  private readonly path: string;
  private fsyncPolicy: FsyncPolicy;
  private everysecTimer: NodeJS.Timeout | null = null;
  /** Bytes written to the current file (used by rewrite triggers). */
  private bytes = 0;
  /** Set during replay so the dispatcher does not re-append. */
  private replaying = false;

  constructor(opts: AofLogOptions) {
    this.path = opts.path;
    this.fsyncPolicy = opts.fsyncPolicy ?? DEFAULT_FSYNC_POLICY;

    // Make sure the parent directory exists. Operators who hand us
    // /var/lib/erix/aof.log shouldn't have to mkdir it themselves.
    mkdirSync(dirname(this.path), { recursive: true });

    // O_APPEND would make concurrent writers safer but we're single-
    // threaded, and we want explicit byte counting for rewrite triggers.
    this.fd = openSync(this.path, "a+");
    if (existsSync(this.path)) {
      try {
        this.bytes = statSync(this.path).size;
      } catch {
        this.bytes = 0;
      }
    }

    if (this.fsyncPolicy === "everysec") {
      this.everysecTimer = setInterval(() => {
        try {
          fsyncSync(this.fd);
        } catch (err) {
          console.error(
            `[AofLog] fsync failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }, EVERYSEC_INTERVAL_MS);
      // Don't keep the process alive just for the AOF timer.
      this.everysecTimer.unref?.();
    }
  }

  // ── Configuration ────────────────────────────────────────────────────────

  get isReplaying(): boolean {
    return this.replaying;
  }

  /** Current file size, in bytes. Used by `BGREWRITEAOF` heuristics later. */
  get sizeBytes(): number {
    return this.bytes;
  }

  // ── Append ───────────────────────────────────────────────────────────────

  /**
   * Append a single entry. No-op while replaying.
   *
   * Writes are synchronous on the dispatcher's hot path so a successful
   * append-then-respond ordering is guaranteed without async juggling.
   * `fsync` happens here under `always`, on a timer under `everysec`,
   * and not at all under `no`.
   */
  append(entry: Omit<AofEntry, "ts">): void {
    if (this.replaying) return;
    const line = `${JSON.stringify({ ts: Date.now(), ...entry })}\n`;
    const buf = Buffer.from(line, "utf8");
    writeSync(this.fd, buf, 0, buf.length, null);
    this.bytes += buf.length;
    if (this.fsyncPolicy === "always") {
      try {
        fsyncSync(this.fd);
      } catch (err) {
        console.error(
          `[AofLog] fsync failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  // ── Replay ───────────────────────────────────────────────────────────────

  /**
   * Read every entry from the file and feed it to `apply`. Lines that
   * fail to parse are logged and skipped — replay is best-effort, not
   * all-or-nothing, so a single torn write at the end of the file does
   * not prevent recovery.
   *
   * Returns the count of entries successfully applied.
   */
  replay(apply: (entry: AofEntry) => void): number {
    if (!existsSync(this.path)) return 0;

    const raw = readFileSync(this.path, "utf8");
    if (raw.length === 0) return 0;

    const lines = raw.split("\n");
    let applied = 0;
    let skipped = 0;
    this.replaying = true;
    try {
      for (const line of lines) {
        if (line.length === 0) continue;
        let entry: AofEntry;
        try {
          entry = JSON.parse(line) as AofEntry;
        } catch {
          skipped++;
          continue;
        }
        if (!isValidEntry(entry)) {
          skipped++;
          continue;
        }
        try {
          apply(entry);
          applied++;
        } catch (err) {
          // A single command failing during replay is logged but not
          // fatal — the operator can inspect the log post-restart.
          console.error(
            `[AofLog] replay failed for ${entry.name} (${entry.tenantId}): ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } finally {
      this.replaying = false;
    }

    if (skipped > 0) {
      console.warn(
        `[AofLog] skipped ${skipped} corrupt or malformed line(s) during replay`,
      );
    }
    return applied;
  }

  // ── Rewrite ──────────────────────────────────────────────────────────────

  /**
   * Replace the current file with a freshly serialised snapshot of the
   * supplied entries. Atomic at the filesystem level: writes a
   * `.rewrite` sibling, fsyncs it, then `rename(2)`s it over the live
   * file. After this returns, the on-disk log is exactly `entries`.
   *
   * Caller is responsible for producing `entries` — typically by walking
   * every key/field/member and emitting a sequence of SET/HSET/RPUSH/etc.
   */
  rewrite(entries: Iterable<Omit<AofEntry, "ts">>): void {
    const tmpPath = `${this.path}.rewrite`;
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmpFd = openSync(tmpPath, "w");
    let bytes = 0;
    try {
      for (const entry of entries) {
        const line = `${JSON.stringify({ ts: Date.now(), ...entry })}\n`;
        const buf = Buffer.from(line, "utf8");
        writeSync(tmpFd, buf, 0, buf.length, null);
        bytes += buf.length;
      }
      fsyncSync(tmpFd);
    } finally {
      closeSync(tmpFd);
    }

    // Close the live fd before renaming — POSIX rename atomically
    // replaces the destination, but Windows refuses to rename over an
    // open file. Closing first keeps the code portable.
    closeSync(this.fd);
    try {
      renameSync(tmpPath, this.path);
    } catch (err) {
      // Recovery: re-open the original file so the AOF keeps working.
      this.fd = openSync(this.path, "a+");
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
    this.fd = openSync(this.path, "a+");
    this.bytes = bytes;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Flush + close. Safe to call multiple times.
   * Tests should call this in `afterEach` to keep handles from leaking
   * between cases.
   */
  close(): void {
    if (this.everysecTimer) {
      clearInterval(this.everysecTimer);
      this.everysecTimer = null;
    }
    try {
      fsyncSync(this.fd);
    } catch {
      // ignore — file may already be closed
    }
    try {
      closeSync(this.fd);
    } catch {
      // ignore — already closed
    }
    // Sentinel value so subsequent operations no-op rather than crash.
    this.fd = -1;
  }

  /** Path to the AOF file (for diagnostics/tests). */
  get filePath(): string {
    return this.path;
  }
}

function isValidEntry(value: unknown): value is AofEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ts === "number" &&
    typeof v.tenantId === "string" &&
    typeof v.name === "string" &&
    Array.isArray(v.args)
  );
}

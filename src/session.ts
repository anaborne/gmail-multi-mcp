/**
 * Session state and the audit trail.
 *
 * The active account is an intent that survives between calls, and intent that survives
 * is the thing that goes stale. Two guards follow from that: it expires, and it never
 * decides a write on its own. Every call is written to the log with the mailbox it used
 * and whether that matched the active one, so an account error is findable after the fact
 * rather than only at the moment it happens.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface ActiveSelection {
  label: string;
  email: string;
  /** Epoch millis. */
  setAt: number;
  note?: string;
}

export class Session {
  private selection: ActiveSelection | undefined;
  /** True once a selection has been dropped for age. active() returns undefined in both
   * cases, so without this the error cannot tell "you never chose" from "your choice ran
   * out". Those need different answers. */
  private lapsed = false;

  constructor(
    /** Minutes before the selection lapses. 0 disables expiry. */
    readonly ttlMinutes: number,
    private readonly now: () => number = Date.now,
  ) {}

  setActive(label: string, email: string, note?: string): ActiveSelection {
    this.selection = { label, email, setAt: this.now(), note };
    this.lapsed = false;
    return this.selection;
  }

  clear(): void {
    this.selection = undefined;
    this.lapsed = false;
  }

  /** Returns nothing once the selection has lapsed, so a stale one cannot steer a call. */
  active(): ActiveSelection | undefined {
    if (!this.selection) return undefined;
    if (this.ttlMinutes <= 0) return this.selection;
    const age = this.now() - this.selection.setAt;
    if (age > this.ttlMinutes * 60_000) {
      this.selection = undefined;
      this.lapsed = true;
      return undefined;
    }
    return this.selection;
  }

  /** True when a selection existed and its window closed. False when none was ever made. */
  didLapse(): boolean {
    return this.lapsed;
  }

  /** Whole minutes remaining, for the message that tells a model when to re-select. */
  minutesRemaining(): number | undefined {
    const current = this.active();
    if (!current || this.ttlMinutes <= 0) return undefined;
    const left = this.ttlMinutes * 60_000 - (this.now() - current.setAt);
    return Math.max(0, Math.ceil(left / 60_000));
  }
}

export type Outcome = 'ok' | 'error' | 'refused';

export interface AuditRecord {
  at: string;
  tool: string;
  outcome: Outcome;
  account?: string;
  email?: string;
  active?: string;
  diverged?: boolean;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  draftId?: string;
  messageId?: string;
  detail?: string;
}

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const TAIL_BYTES = 1024 * 1024;

/** Best effort by construction. A mail call must not fail because a log line could not be
 * written, and a log that throws on a full disk would do exactly that. */
export class AuditLog {
  private warned = false;
  /** undefined until the first write attempt. false disables every later attempt, so one
   * unwritable path costs one failed syscall rather than one per call. */
  private usable: boolean | undefined;

  constructor(
    readonly path: string | undefined,
    private readonly warn: (message: string) => void = (m) => process.stderr.write(m),
  ) {}

  get enabled(): boolean {
    return this.path !== undefined;
  }

  record(entry: Omit<AuditRecord, 'at'> & { at?: string }): void {
    if (!this.path) return;
    if (this.usable === false) return;
    const line = JSON.stringify({ at: entry.at ?? new Date().toISOString(), ...entry });
    try {
      if (this.usable === undefined) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.usable = true;
      }
      this.rotateIfLarge();
      appendFileSync(this.path, `${line}\n`, { mode: 0o600 });
    } catch (err) {
      this.usable = false;
      if (!this.warned) {
        this.warned = true;
        this.warn(
          `gmail-multi-mcp: could not write the audit log at ${this.path}: ` +
            `${err instanceof Error ? err.message : String(err)}. Calls continue unlogged.\n`,
        );
      }
    }
  }

  private rotateIfLarge(): void {
    if (!this.path || !existsSync(this.path)) return;
    if (statSync(this.path).size < MAX_LOG_BYTES) return;
    renameSync(this.path, `${this.path}.1`);
  }

  /** Newest first. Reads only the tail of a large file, since the whole point is recency. */
  recent(limit: number, account?: string): AuditRecord[] {
    if (!this.path || !existsSync(this.path)) return [];
    let text: string;
    try {
      const size = statSync(this.path).size;
      if (size <= TAIL_BYTES) {
        text = readFileSync(this.path, 'utf8');
      } else {
        // Read from a position, so a large log costs one buffer. Reading the whole file
        // and then copying the end out of it holds all of it in memory.
        const buffer = Buffer.alloc(TAIL_BYTES);
        const fd = openSync(this.path, 'r');
        try {
          readSync(fd, buffer, 0, TAIL_BYTES, size - TAIL_BYTES);
        } finally {
          closeSync(fd);
        }
        // Drop the first, probably partial, line.
        text = buffer.toString('utf8').slice(buffer.toString('utf8').indexOf('\n') + 1);
      }
    } catch {
      return [];
    }

    const records: AuditRecord[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as AuditRecord;
        if (account && parsed.account !== account) continue;
        records.push(parsed);
      } catch {
        // A truncated final line from a killed process is not worth failing the read over.
      }
    }
    return records.slice(-limit).reverse();
  }
}

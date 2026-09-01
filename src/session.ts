/**
 * Session state and the audit trail.
 *
 * The active account is an intent that survives between calls, and intent that survives
 * is the thing that goes stale. Two guards follow from that: it expires, and it never
 * decides a write on its own. Every call is written to the log with the mailbox it used
 * and whether that matched the active one, so an account error is findable after the fact
 * rather than only at the moment it happens.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, existsSync } from 'node:fs';
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

  constructor(
    /** Minutes before the selection lapses. 0 disables expiry. */
    readonly ttlMinutes: number,
    private readonly now: () => number = Date.now,
  ) {}

  setActive(label: string, email: string, note?: string): ActiveSelection {
    this.selection = { label, email, setAt: this.now(), note };
    return this.selection;
  }

  clear(): void {
    this.selection = undefined;
  }

  /** Returns nothing once the selection has lapsed, so a stale one cannot steer a call. */
  active(): ActiveSelection | undefined {
    if (!this.selection) return undefined;
    if (this.ttlMinutes <= 0) return this.selection;
    const age = this.now() - this.selection.setAt;
    if (age > this.ttlMinutes * 60_000) {
      this.selection = undefined;
      return undefined;
    }
    return this.selection;
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
        const buffer = Buffer.alloc(TAIL_BYTES);
        const fd = readFileSync(this.path);
        fd.copy(buffer, 0, size - TAIL_BYTES);
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

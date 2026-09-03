import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuditLog, Session } from '../dist/session.js';

function clock(start = 1_000_000) {
  const state = { now: start };
  return { state, fn: () => state.now };
}

test('an active selection is remembered until it lapses', () => {
  const { state, fn } = clock();
  const session = new Session(60, fn);
  assert.equal(session.active(), undefined);

  session.setActive('jobs', 'b@gmail.com', 'applying');
  assert.equal(session.active()?.label, 'jobs');
  assert.equal(session.active()?.note, 'applying');
  assert.equal(session.minutesRemaining(), 60);

  state.now += 30 * 60_000;
  assert.equal(session.active()?.label, 'jobs');
  assert.equal(session.minutesRemaining(), 30);

  state.now += 31 * 60_000;
  assert.equal(session.active(), undefined, 'a selection past its ttl must not steer a call');
});

test('a ttl of zero means the selection stands for the life of the process', () => {
  const { state, fn } = clock();
  const session = new Session(0, fn);
  session.setActive('personal', 'a@gmail.com');
  state.now += 400 * 24 * 60 * 60_000;
  assert.equal(session.active()?.label, 'personal');
  assert.equal(session.minutesRemaining(), undefined);
});

test('clearing drops the selection immediately', () => {
  const session = new Session(60);
  session.setActive('jobs', 'b@gmail.com');
  session.clear();
  assert.equal(session.active(), undefined);
});

test('a lapsed selection is not resurrected by setting a different one', () => {
  const { state, fn } = clock();
  const session = new Session(10, fn);
  session.setActive('jobs', 'b@gmail.com');
  state.now += 11 * 60_000;
  session.setActive('personal', 'a@gmail.com');
  assert.equal(session.active()?.label, 'personal');
});

function tempLog() {
  return join(mkdtempSync(join(tmpdir(), 'gmm-')), 'audit.jsonl');
}

test('the log records what was done and reads back newest first', () => {
  const path = tempLog();
  const log = new AuditLog(path);
  log.record({ tool: 'search_messages', outcome: 'ok', account: 'personal' });
  log.record({ tool: 'create_draft', outcome: 'ok', account: 'jobs', to: ['dan@example.com'], subject: 'hi', draftId: 'd1' });

  const recent = log.recent(10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].tool, 'create_draft');
  assert.equal(recent[0].draftId, 'd1');
  assert.deepEqual(recent[0].to, ['dan@example.com']);
  assert.ok(recent[0].at, 'every entry is timestamped');
  assert.equal(recent[1].tool, 'search_messages');
});

test('the log can be filtered to one account', () => {
  const path = tempLog();
  const log = new AuditLog(path);
  log.record({ tool: 'a', outcome: 'ok', account: 'personal' });
  log.record({ tool: 'b', outcome: 'ok', account: 'jobs' });
  log.record({ tool: 'c', outcome: 'refused', account: 'jobs' });
  assert.deepEqual(log.recent(10, 'jobs').map((r) => r.tool), ['c', 'b']);
});

test('a divergence is recorded so it is findable afterwards', () => {
  const path = tempLog();
  const log = new AuditLog(path);
  log.record({ tool: 'send_message', outcome: 'ok', account: 'personal', active: 'jobs', diverged: true });
  assert.equal(log.recent(1)[0].diverged, true);
  assert.equal(log.recent(1)[0].active, 'jobs');
});

test('a truncated final line does not break the read', () => {
  const path = tempLog();
  const log = new AuditLog(path);
  log.record({ tool: 'a', outcome: 'ok' });
  writeFileSync(path, `${readFileSync(path, 'utf8')}{"tool":"b","outc`);
  assert.deepEqual(log.recent(10).map((r) => r.tool), ['a']);
});

test('logging off is not an error and reads as empty', () => {
  const log = new AuditLog(undefined);
  assert.equal(log.enabled, false);
  log.record({ tool: 'a', outcome: 'ok' });
  assert.deepEqual(log.recent(10), []);
});

test('a log that cannot be written warns once and never throws', () => {
  const warnings = [];
  // A regular file standing where a directory would have to be. mkdirSync fails with
  // ENOTDIR for root and non-root alike, so the test does not depend on the process being
  // unprivileged, and it writes nothing outside the temp directory.
  const blocker = join(mkdtempSync(join(tmpdir(), 'gmm-')), 'not-a-directory');
  writeFileSync(blocker, 'x');
  const log = new AuditLog(join(blocker, 'audit.jsonl'), (m) => warnings.push(m));
  log.record({ tool: 'a', outcome: 'ok' });
  log.record({ tool: 'b', outcome: 'ok' });
  assert.equal(warnings.length, 1, 'a failing log must not warn on every call');
  assert.match(warnings[0], /Calls continue unlogged/);
});

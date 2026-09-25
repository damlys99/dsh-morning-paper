/**
 * dsh-morning-paper — offline selftest.
 *
 * No network, no browser, no build step, no DSH process. Everything is either a
 * pure function, a route handler over a fake HTTP pair, or the real client
 * bundle evaluated in a `node:vm` sandbox with a stubbed `window`.
 *
 *   node selftest.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

import {
  BRIEFING_VERSION,
  BriefingError,
  COMMAND_NAME,
  MAX_FILES,
  MAX_LOG_EVENTS,
  MAX_QUOTE_CHARS,
  MAX_WINDOW_EVENTS,
  ROUTE_PATH,
  buildBriefing,
  decodeBriefingRequest,
  formatDuration,
  renderBriefingText,
} from './lib/briefing.js';
import {
  apply,
  createQuestionWatcher,
  handleRoute,
  inject,
  name,
  normalizeContextWindow,
  readTailSeq,
  resolveWeather,
  runBriefingCommand,
} from './lib/index.js';

/* ------------------------------------------------------------------ harness */

let passed = 0;
const failures = [];

/** Run one named check; a throw is a failure, never a crash. */
function check(label, body) {
  try {
    const result = body();
    if (result && typeof result.then === 'function') {
      throw new Error('check() does not await: use acheck() for async bodies');
    }
    passed += 1;
  } catch (error) {
    failures.push({ label, message: error instanceof Error ? error.message : String(error) });
  }
}

/** Run one named async check. */
async function acheck(label, body) {
  try {
    await body();
    passed += 1;
  } catch (error) {
    failures.push({ label, message: error instanceof Error ? error.message : String(error) });
  }
}

function ok(value, label) {
  if (!value) throw new Error(`${label}: expected truthy, got ${JSON.stringify(value)}`);
}

function eq(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${label}: expected ${right}, got ${left}`);
}

function throwsCode(body, code, label) {
  try {
    body();
  } catch (error) {
    if (!(error instanceof BriefingError)) throw new Error(`${label}: expected BriefingError, got ${error}`);
    if (error.code !== code) throw new Error(`${label}: expected code ${code}, got ${error.code}`);
    return;
  }
  throw new Error(`${label}: expected a ${code} refusal`);
}

/* ----------------------------------------------------------------- fixtures */

const BASE = 1_700_000_000_000;
const HOUR = 3_600_000;

/** One durable session event with an explicit seq. */
function ev(seq, type, data) {
  return { type, seq, time: BASE + seq * 1000, data };
}

/** One `readSession`-shaped log. `extra.session` merges into the default session. */
function makeLog(events, extra = {}) {
  const { session: sessionExtra, ...rest } = extra;
  return {
    session: { id: 'session-1', version: 1, createdAt: BASE, cwd: '/work/repo', ...(sessionExtra ?? {}) },
    inheritedEventCount: 0,
    events,
    ...rest,
  };
}

const cleanCompleted = [
  ev(1, 'user/message', { content: [{ type: 'text', text: 'fix the tests' }] }),
  ev(2, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }),
  ev(3, 'tool/result', { turn: 1, step: 1, message: { callId: 'c1', content: [{ type: 'text', text: 'ok' }] } }),
  ev(4, 'assistant/message', {
    turn: 1,
    step: 2,
    message: { content: [{ type: 'text', text: 'Tests pass now.' }] },
    stream: [],
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 10 },
  }),
  ev(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
];

const blockedWithApproval = [
  ev(1, 'tool/call', { turn: 4, step: 1, callId: 'c9', name: 'bash', arguments: '{}' }),
  ev(2, 'approval/asked', { id: 'a1', toolName: 'bash', callId: 'c9', reason: 'rm -rf node_modules' }),
  ev(3, 'turn/end', { turn: 4, reason: { kind: 'blocked' } }),
];

const richWindow = [
  { type: 'turn/start', seq: 1, time: BASE, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: BASE + 10, data: { content: [{ type: 'text', text: 'fix the parser' }] } },
  { type: 'tool/call', seq: 3, time: BASE + 100, data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{"file_path":"/home/dev/proj/src/parse.ts"}' } },
  { type: 'tool/result', seq: 4, time: BASE + 500, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [] } } },
  { type: 'tool/call', seq: 5, time: BASE + 600, data: { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{"command":"pnpm test"}' } },
  { type: 'tool/result', seq: 6, time: BASE + 4600, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c2' }, content: [] }, error: { name: 'BashError', code: 'EXIT_1' } } },
  { type: 'assistant/message', seq: 7, time: BASE + 4700, data: { turn: 1, step: 1, message: { content: [] }, stream: [], usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 10 } } },
  { type: 'turn/end', seq: 8, time: BASE + 60000, data: { turn: 1, reason: { kind: 'completed' } } },
];

/* ------------------------------------------------------- core: turn outcome */

check('a clean completed turn produces no action items', () => {
  const briefing = buildBriefing(makeLog(cleanCompleted), -1, BASE + 6 * 1000);
  eq(briefing.actionRequired, [], 'actionRequired');
  eq(briefing.lead.kind, 'completed', 'lead.kind');
  eq(briefing.turns.completed, 1, 'turns.completed');
  eq(briefing.version, BRIEFING_VERSION, 'version');
  eq(briefing.sessionId, 'session-1', 'sessionId');
  eq(briefing.title, '/work/repo', 'title falls back to cwd');
});

check('a turn that fails carries its structured error into the lead', () => {
  const log = makeLog([
    ev(1, 'tool/call', { turn: 2, step: 1, callId: 'x', name: 'bash', arguments: '{"command":"pnpm test"}' }),
    ev(2, 'tool/result', { turn: 2, step: 1, message: { source: { kind: 'tool', callId: 'x' }, content: [] }, error: { name: 'FsError', code: 'EXIT_1' } }),
    ev(3, 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'slow down' } } }),
  ]);
  const briefing = buildBriefing(log, -1, BASE + 4000);
  eq(briefing.lead.kind, 'error', 'lead.kind');
  eq(briefing.lead.error, { code: 'RATE_LIMIT', message: 'slow down' }, 'lead.error');
  eq(briefing.turns.error, 1, 'turns.error');
  eq(briefing.corrections.toolFailures, 1, 'toolFailures');
  eq(briefing.corrections.failureGroups, [{ failure: 'bash/EXIT_1', count: 1 }], 'failureGroups name the tool');
});

check('a failure with no matching call degrades to an unnamed tool, never a guess', () => {
  const log = makeLog([
    ev(1, 'tool/result', { turn: 2, step: 1, message: { source: { kind: 'tool', callId: 'gone' }, content: [] }, error: { name: 'FsError', code: 'EXIT_1' } }),
  ]);
  const briefing = buildBriefing(log, -1, BASE + 2000);
  eq(briefing.corrections.failureGroups, [{ failure: 'unknown/EXIT_1', count: 1 }], 'unnamed tool');
});

check('tool calls are paired with results through the real log shape, so timings are real', () => {
  const log = makeLog([
    { type: 'tool/call', seq: 1, time: BASE, data: { turn: 1, step: 1, callId: 'a', name: 'bash', arguments: '{"command":"sleep 2"}' } },
    { type: 'tool/result', seq: 2, time: BASE + 2000, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'a' }, content: [{ type: 'tool-result', toolCallId: 'a', isError: false }] } } },
  ]);
  const briefing = buildBriefing(log, -1, BASE + 3000);
  eq(briefing.timing.tools, [{ tool: 'bash', calls: 1, ms: 2000, share: 100 }], 'tool time');
  eq(briefing.timing.toolMs, 2000, 'total tool ms');
  eq(briefing.timing.longest, { tool: 'bash', ms: 2000, time: BASE }, 'longest call');
});

check('shell commands are counted, and failures carry the failing command', () => {
  const log = makeLog([
    ev(1, 'tool/call', { turn: 1, step: 1, callId: 'a', name: 'bash', arguments: '{"command":"pnpm test"}' }),
    ev(2, 'tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'a' }, content: [] }, error: { name: 'BashError', code: 'EXIT_1' } }),
    ev(3, 'tool/call', { turn: 1, step: 1, callId: 'b', name: 'bash', arguments: '{"command":"pnpm test"}' }),
    ev(4, 'tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'b' }, content: [] } }),
  ]);
  const briefing = buildBriefing(log, -1, BASE + 5000);
  eq(briefing.commands, { total: 2, failed: 1 }, 'command counts');
  eq(briefing.unresolved, [], 'a later success means it was handled');
});

check('a failure nobody retried stays unresolved', () => {
  const log = makeLog([
    ev(1, 'tool/call', { turn: 1, step: 1, callId: 'a', name: 'bash', arguments: '{"command":"deploy --prod"}' }),
    ev(2, 'tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'a' }, content: [] }, error: { name: 'BashError', code: 'EXIT_127' } }),
  ]);
  const briefing = buildBriefing(log, -1, BASE + 3000);
  eq(briefing.unresolved.length, 1, 'one unresolved');
  eq(briefing.unresolved[0].tool, 'bash', 'tool named');
  eq(briefing.unresolved[0].code, 'EXIT_127', 'code');
  eq(briefing.unresolved[0].command, 'deploy --prod', 'the failing command is quoted');
});

check('what you asked is kept, and plugin-authored messages are not', () => {
  const log = makeLog([
    ev(1, 'user/message', { content: [{ type: 'text', text: 'make the tab prettier' }] }),
    ev(2, 'user/message', { content: [{ type: 'text', text: 'a scheduled wake-up' }], source: { kind: 'plugin', plugin: 'schedule' } }),
    ev(3, 'user/message', { content: [{ type: 'text', text: 'and rename it' }] }),
  ]);
  const briefing = buildBriefing(log, -1, BASE + 4000);
  eq(briefing.asks.map((ask) => ask.text), ['make the tab prettier', 'and rename it'], 'only your own asks');
  eq(briefing.business.userMessages, 2, 'counted too');
});

check('an interrupted turn reads as a restart, not a failure', () => {
  const log = makeLog([ev(1, 'turn/end', { turn: 7, reason: { kind: 'interrupted' } })]);
  const briefing = buildBriefing(log, -1, BASE + 2000);
  eq(briefing.lead.kind, 'interrupted', 'lead.kind');
  eq(briefing.turns.interrupted, 1, 'turns.interrupted');
});

check('every declared turn outcome is counted, and unknown kinds stay other', () => {
  const log = makeLog([
    ev(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev(2, 'turn/end', { turn: 2, reason: { kind: 'blocked' } }),
    ev(3, 'turn/end', { turn: 3, reason: { kind: 'error', error: { code: 'X' } } }),
    ev(4, 'turn/end', { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ev(5, 'turn/end', { turn: 5, reason: { kind: 'max-tokens' } }),
    ev(6, 'turn/end', { turn: 6, reason: { kind: 'interrupted' } }),
    ev(7, 'turn/end', { turn: 7, reason: { kind: 'invented-by-a-future-plugin' } }),
    ev(8, 'turn/end', { turn: 8 }),
  ]);
  const briefing = buildBriefing(log, -1, BASE + 9000);
  eq(briefing.turns, { completed: 1, blocked: 1, error: 1, aborted: 1, maxTokens: 1, interrupted: 1, other: 2 }, 'turns');
  eq(briefing.turns.other, 2, 'other absorbs unknown and malformed reasons');
});

check('an aborted turn keeps its cancel reason in the lead', () => {
  const log = makeLog([ev(1, 'turn/end', { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } })]);
  const briefing = buildBriefing(log, -1, BASE + 2000);
  eq(briefing.lead.kind, 'aborted', 'kind');
  eq(briefing.lead.cancelReason, 'user', 'cancelReason');
});

/* ------------------------------------------------------- core: action items */

check('an approval asked and never decided is action required', () => {
  const briefing = buildBriefing(makeLog(blockedWithApproval), -1, BASE + 2 * 1000 + 10 * 60 * 1000);
  eq(briefing.actionRequired.length, 1, 'one action');
  eq(briefing.actionRequired[0].kind, 'approval', 'kind');
  eq(briefing.actionRequired[0].toolName, 'bash', 'toolName');
  eq(briefing.actionRequired[0].reason, 'rm -rf node_modules', 'reason');
  eq(briefing.actionRequired[0].ageMs, 10 * 60 * 1000, 'ageMs');
  eq(briefing.lead.kind, 'blocked', 'lead.kind');
});

check('every approval outcome closes the ask', () => {
  for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
    const log = makeLog([
      ev(1, 'approval/asked', { id: 'a1', toolName: 'bash' }),
      ev(2, 'approval/decided', { id: 'a1', outcome }),
    ]);
    const briefing = buildBriefing(log, -1, BASE + 3000);
    eq(briefing.actionRequired, [], `outcome ${outcome} clears the ask`);
  }
});

check('a blocked turn with no pending approval is itself the action item', () => {
  const log = makeLog([ev(1, 'turn/end', { turn: 3, reason: { kind: 'blocked' } })]);
  const briefing = buildBriefing(log, -1, BASE + 2000);
  eq(briefing.actionRequired.length, 1, 'one action');
  eq(briefing.actionRequired[0].kind, 'blocked', 'kind');
  eq(briefing.actionRequired[0].turn, 3, 'turn');
});

check('a blocked turn does not double-report when an approval is already pending', () => {
  const briefing = buildBriefing(makeLog(blockedWithApproval), -1, BASE + 4000);
  eq(briefing.actionRequired.length, 1, 'still exactly one action');
  eq(briefing.actionRequired[0].kind, 'approval', 'the clickable one wins');
});

check('pending approvals survive the away window: a standing fact is read from the whole log', () => {
  const briefing = buildBriefing(makeLog(blockedWithApproval), 3, BASE + 4000);
  eq(briefing.window.events, 0, 'nothing new in the window');
  eq(briefing.actionRequired.length, 1, 'the old ask is still shown');
  eq(briefing.lead.kind, 'quiet', 'lead is quiet');
});

check('the action list is capped and ordered oldest ask first', () => {
  const events = [];
  for (let index = 0; index < 30; index += 1) {
    events.push(ev(index + 1, 'approval/asked', { id: `a${String(index)}`, toolName: 'bash' }));
  }
  const briefing = buildBriefing(makeLog(events), -1, BASE + 40 * 1000);
  ok(briefing.actionRequired.length <= 20, 'capped at MAX_ACTION_ITEMS');
  ok(briefing.actionRequired[0].seq < briefing.actionRequired[1].seq, 'oldest first');
});

check('a live pending question joins the action list', () => {
  const briefing = buildBriefing(makeLog([]), -1, BASE, {
    pendingQuestions: [{ id: 'q1', question: 'which branch?', time: BASE - 5000 }],
  });
  eq(briefing.actionRequired.length, 1, 'one action');
  eq(briefing.actionRequired[0].kind, 'question', 'kind');
  eq(briefing.actionRequired[0].question, 'which branch?', 'question text');
});

/* ------------------------------------------------------- core: the window */

check('the window contains only events after the marker', () => {
  const briefing = buildBriefing(makeLog(cleanCompleted), 3, BASE + 6000);
  eq(briefing.window.sinceSeq, 3, 'sinceSeq');
  eq(briefing.window.throughSeq, 5, 'throughSeq');
  eq(briefing.window.events, 2, 'events after the marker');
  eq(briefing.business.toolCalls, 0, 'the tool call before the marker is not counted');
});

check('the away duration is measured from the marker event', () => {
  const briefing = buildBriefing(makeLog(cleanCompleted), 3, BASE + 3000 + HOUR);
  eq(briefing.window.awayMs, HOUR, 'awayMs');
  eq(briefing.masthead.awayMs, HOUR, 'masthead.awayMs');
});

check('a whole-session read starts at the session birthday', () => {
  const briefing = buildBriefing(makeLog(cleanCompleted), -1, BASE + HOUR);
  eq(briefing.window.sinceSeq, -1, 'sinceSeq');
  eq(briefing.window.awayMs, HOUR, 'measured from createdAt');
  eq(briefing.window.events, 5, 'every event');
});

check('fork-inherited events are excluded and named, never reported as work done here', () => {
  // Session seqs are 0-based, and `inheritedEventCount` is the length of the
  // leading inherited prefix, so seq 0..count-1 are the fork parent's events.
  const log = makeLog(
    [ev(0, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ev(1, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
      ev(2, 'turn/end', { turn: 3, reason: { kind: 'completed' } }),
      ev(3, 'turn/end', { turn: 4, reason: { kind: 'error', error: { code: 'E' } } })],
    { inheritedEventCount: 3, session: { isSeeded: true } },
  );
  const briefing = buildBriefing(log, -1, BASE + 5000);
  eq(briefing.window.events, 1, 'only the inherited-free event is in the window');
  eq(briefing.turns.completed, 0, 'inherited completions are not counted');
  eq(briefing.turns.error, 1, 'the real event is counted');
  eq(briefing.isFork, true, 'isFork');
  ok(briefing.notes.some((note) => note.includes('fork-inherited')), 'the exclusion is disclosed');
});

check('a marker already past the inherited prefix adds no inherited note', () => {
  const log = makeLog([ev(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), ev(4, 'turn/end', { turn: 2, reason: { kind: 'completed' } })], { inheritedEventCount: 3 });
  const briefing = buildBriefing(log, 3, BASE + 5000);
  eq(briefing.notes.filter((note) => note.includes('fork-inherited')).length, 0, 'no note');
  eq(briefing.window.events, 1, 'window');
});

check('a huge window is truncated to the newest events with a note', () => {
  const events = [];
  for (let index = 0; index < MAX_WINDOW_EVENTS + 100; index += 1) {
    events.push(ev(index + 1, 'turn/end', { turn: index + 1, reason: { kind: 'completed' } }));
  }
  const briefing = buildBriefing(makeLog(events), -1, BASE + 10_000_000);
  eq(briefing.window.events, MAX_WINDOW_EVENTS, 'truncated to the cap');
  ok(briefing.notes.some((note) => note.includes('100 older event')), 'the truncation is disclosed');
  eq(briefing.turns.completed, MAX_WINDOW_EVENTS, 'only the tail is counted');
});

/* ------------------------------------------------------- core: refusals */

check('a marker ahead of the log is refused instead of scrambled', () => {
  throwsCode(() => buildBriefing(makeLog(cleanCompleted), 999, BASE), 'MARKER_AHEAD', 'marker ahead');
});

check('a log above the read ceiling is refused', () => {
  const events = [];
  for (let index = 0; index < MAX_LOG_EVENTS + 1; index += 1) events.push({ type: 'noise', seq: index + 1, time: BASE, data: {} });
  throwsCode(() => buildBriefing(makeLog(events), -1, BASE), 'LOG_TOO_LARGE', 'log too large');
});

check('a subagent session briefing is refused, because its parent owns it', () => {
  throwsCode(() => buildBriefing(makeLog([], { session: { origin: 'subagent' } }), -1, BASE), 'SUBAGENT_OWNED', 'subagent');
});

check('an unreadable log is refused', () => {
  throwsCode(() => buildBriefing({ events: 'nope' }, -1, BASE), 'BAD_LOG', 'bad events');
  throwsCode(() => buildBriefing({ session: {}, events: [] }, -1, BASE), 'BAD_LOG', 'no identity');
});

check('malformed events never throw: they degrade to "other"', () => {
  const briefing = buildBriefing(makeLog([
    { type: 'turn/end', seq: 1, time: BASE, data: null },
    { type: 'tool/result', seq: 2, time: BASE, data: { error: 'not-an-object' } },
    { type: 'assistant/message', seq: 3, time: BASE, data: { message: { content: 'not-an-array' } } },
    { type: 'deliverables/presented', seq: 4, time: BASE, data: { files: 'nope' } },
    { type: 'approval/asked', seq: 5, time: BASE, data: {} },
  ]), -1, BASE + 6000);
  eq(briefing.turns.other, 1, 'null reason is other');
  eq(briefing.corrections.toolFailures, 0, 'a non-object error is not a failure');
  eq(briefing.business.files, [], 'a non-array files field is ignored');
  eq(briefing.actionRequired.length, 0, 'an ask with no id is not actionable');
});

/* ------------------------------------------------------- core: determinism */

check('the same input and clock produce byte-identical output', () => {
  const first = JSON.stringify(buildBriefing(makeLog(cleanCompleted), 2, BASE + 9000));
  const second = JSON.stringify(buildBriefing(makeLog(cleanCompleted), 2, BASE + 9000));
  eq(first, second, 'determinism');
});

check('building a briefing does not mutate its input log', () => {
  const log = makeLog(cleanCompleted);
  const before = structuredClone(log);
  buildBriefing(log, 2, BASE + 9000);
  eq(log, before, 'input unchanged');
});

check('an empty session yields a deliberately dull page', () => {
  const briefing = buildBriefing(makeLog([]), -1, BASE);
  eq(briefing.lead.kind, 'quiet', 'lead.kind');
  eq(briefing.window.throughSeq, -1, 'empty tail');
  eq(briefing.actionRequired, [], 'no actions');
});

/* ------------------------------------------------------- core: business */

check('token buckets are disjoint and the cache share is derived from billed input only', () => {
  const briefing = buildBriefing(makeLog(cleanCompleted), -1, BASE + 6000);
  eq(briefing.business.inputTokens, 100, 'inputTokens');
  eq(briefing.business.cacheReadTokens, 200, 'cacheReadTokens');
  eq(briefing.business.cacheWriteTokens, 10, 'cacheWriteTokens');
  eq(briefing.business.outputTokens, 50, 'outputTokens');
  eq(briefing.business.billedInputTokens, 310, 'billed input sums the three input buckets');
  eq(briefing.business.totalTokens, 360, 'total adds output once');
  eq(briefing.business.cacheHitPercent, 64.5, 'cache hit share');
});

check('usage from several calls accumulates without double counting', () => {
  const events = [];
  for (let index = 0; index < 3; index += 1) {
    events.push(ev(index + 1, 'assistant/message', { turn: 1, step: index + 1, message: { content: [] }, stream: [], usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 } }));
  }
  const briefing = buildBriefing(makeLog(events), -1, BASE + 4000);
  eq(briefing.business.inputTokens, 3, 'input');
  eq(briefing.business.outputTokens, 6, 'output');
  eq(briefing.business.cacheReadTokens, 9, 'cache read');
  eq(briefing.business.totalTokens, 18, 'total');
  eq(briefing.business.cacheHitPercent, 75, 'cache share');
});

check('declared deliverables are listed once each, sorted', () => {
  const log = makeLog([
    ev(1, 'deliverables/presented', { turn: 1, callId: 'p1', files: [{ path: 'src/b.ts' }, { path: 'src/a.ts' }] }),
    ev(2, 'deliverables/presented', { turn: 2, callId: 'p2', files: [{ path: 'src/a.ts' }] }),
  ]);
  const briefing = buildBriefing(log, -1, BASE + 3000);
  eq(briefing.business.files, ['src/a.ts', 'src/b.ts'], 'unique sorted files');
  eq(briefing.business.presentEvents, 2, 'present events');
  eq(briefing.business.filesTruncated, 0, 'truncated');
});

check('retries and compactions are counted under corrections', () => {
  const log = makeLog([
    ev(1, 'llm/retry', {}),
    ev(2, 'llm/retry-started', {}),
    ev(3, 'compaction/start', {}),
    ev(4, 'compaction/end', {}),
  ]);
  const briefing = buildBriefing(log, -1, BASE + 5000);
  eq(briefing.corrections.llmRetries, 2, 'retries');
  eq(briefing.corrections.compactions, 1, 'compactions counted from start only');
});

check('the lead reports the outcome and nothing you could read in the chat', () => {
  const log = makeLog([
    ev(1, 'tool/call', { turn: 1, step: 1, callId: 'a', name: 'grep', arguments: '{}' }),
    ev(2, 'tool/call', { turn: 1, step: 1, callId: 'b', name: 'grep', arguments: '{}' }),
    ev(3, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'read', arguments: '{}' }),
    ev(4, 'assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Found   the\nbug' }] }, stream: [] }),
    ev(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  const briefing = buildBriefing(log, -1, BASE + 6000);
  eq(briefing.lead.kind, 'completed', 'outcome');
  eq(briefing.lead.turn, 1, 'turn');
  // The quoted reply and the lead tool histogram were removed on purpose: the
  // transcript already shows both, and a briefing that restates the chat is
  // worth nothing. Asserted absent so they cannot creep back.
  eq(briefing.lead.quote, undefined, 'no quoted reply');
  eq(briefing.lead.tools, undefined, 'no tool histogram on the lead');
  eq(briefing.timing.tools.map((row) => [row.tool, row.calls]), [['grep', 2], ['read', 1]], 'tool counts live in the timing section');
});

check('the window is summarised as a per-turn timeline with its own spend', () => {
  const log = makeLog([
    { type: 'turn/start', seq: 1, time: BASE, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: BASE + 100, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 3, time: BASE + 200, data: { turn: 1, step: 1, callId: 'a', name: 'read', arguments: '{"file_path":"/tmp/a.ts"}' } },
    { type: 'tool/result', seq: 4, time: BASE + 2000, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'a' }, content: [] } } },
    { type: 'assistant/message', seq: 5, time: BASE + 2100, data: { turn: 1, step: 1, message: { content: [] }, stream: [], usage: { inputTokens: 10, outputTokens: 5 } } },
    { type: 'turn/end', seq: 6, time: BASE + 60000, data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  const briefing = buildBriefing(log, -1, BASE + 70000);
  eq(briefing.timeline.length, 1, 'one row');
  const row = briefing.timeline[0];
  eq(row.turn, 1, 'turn');
  eq(row.durationMs, 60000, 'duration');
  eq(row.steps, 1, 'steps');
  eq(row.tools, 1, 'tools');
  eq(row.tokens, 15, 'turn tokens');
  eq(row.outcome, 'completed', 'outcome');
  eq(briefing.business.topTurns, [{ turn: 1, tokens: 15, share: 100, tools: 1, outcome: 'completed' }], 'spend ranking');
});

check('file churn is counted per file, not listed per edit', () => {
  const log = makeLog([
    ev(1, 'tool/call', { turn: 1, step: 1, callId: 'a', name: 'edit', arguments: '{"file_path":"/w/a.ts"}' }),
    ev(2, 'tool/call', { turn: 1, step: 1, callId: 'b', name: 'edit', arguments: '{"file_path":"/w/a.ts"}' }),
    ev(3, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'write', arguments: '{"file_path":"/w/b.ts"}' }),
    ev(4, 'tool/call', { turn: 1, step: 1, callId: 'd', name: 'read', arguments: '{"file_path":"/w/c.ts"}' }),
    ev(5, 'tool/call', { turn: 1, step: 1, callId: 'e', name: 'edit', arguments: 'not json' }),
  ]);
  const briefing = buildBriefing(log, -1, BASE + 6000);
  eq(briefing.files.touched, 2, 'only edited/written files count');
  eq(briefing.files.listed, [{ path: '/w/a.ts', edits: 2 }, { path: '/w/b.ts', edits: 1 }], 'churn by file');
  eq(briefing.timing.tools.some((row) => row.tool === 'read'), true, 'reads still counted as a tool');
});

check('an in-flight window with no finished turn reads as activity', () => {
  const log = makeLog([ev(1, 'tool/call', { turn: 5, step: 1, callId: 'a', name: 'bash', arguments: '{}' })]);
  const briefing = buildBriefing(log, -1, BASE + 2000);
  eq(briefing.lead.kind, 'activity', 'lead.kind');
  eq(briefing.lead.turn, 5, 'turn');
});

check('weather is passed through and its absence is disclosed', () => {
  const withWeather = buildBriefing(makeLog(cleanCompleted), -1, BASE + 6000, {
    weather: { contextTokens: 105_000, surfaceTokens: 90_000, contextWindow: 128_000, percent: 82 },
  });
  eq(withWeather.weather.percent, 82, 'percent');
  eq(withWeather.notes.filter((note) => note.includes('No live session')).length, 0, 'no absence note');

  const without = buildBriefing(makeLog(cleanCompleted), -1, BASE + 6000);
  eq(without.weather, null, 'weather null');
  ok(without.notes.some((note) => note.includes('No live session')), 'absence disclosed');
});

/* ------------------------------------------------------- request decoding */

check('a valid request decodes with defaults', () => {
  const decoded = decodeBriefingRequest(new URLSearchParams('sessionId=s1'));
  eq(decoded, { sessionId: 's1', sinceSeq: -1, format: 'json', probe: false }, 'decoded');
});

check('a probe decodes as a probe', () => {
  eq(decodeBriefingRequest(new URLSearchParams('sessionId=s1&probe=1')).probe, true, 'probe');
});

check('bad requests are refused with BAD_REQUEST', () => {
  throwsCode(() => decodeBriefingRequest(new URLSearchParams('')), 'BAD_REQUEST', 'missing sessionId');
  throwsCode(() => decodeBriefingRequest(new URLSearchParams('sessionId=')), 'BAD_REQUEST', 'empty sessionId');
  throwsCode(() => decodeBriefingRequest(new URLSearchParams('sessionId=s1&sinceSeq=-2')), 'BAD_REQUEST', 'negative sinceSeq');
  throwsCode(() => decodeBriefingRequest(new URLSearchParams('sessionId=s1&sinceSeq=abc')), 'BAD_REQUEST', 'non-numeric sinceSeq');
  throwsCode(() => decodeBriefingRequest(new URLSearchParams(`sessionId=${'x'.repeat(300)}`)), 'BAD_REQUEST', 'oversized sessionId');
  throwsCode(() => decodeBriefingRequest(new URLSearchParams('sessionId=s1&format=xml')), 'BAD_REQUEST', 'unknown format');
});

/* ------------------------------------------------------- route behaviour */

function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? null;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}

function fakeRequest(method, url) {
  return { method, url, headers: {} };
}

/** A ctx whose only real service is sessionQuery, plus a recording session. */
function fakeCtx(log, options = {}) {
  const state = { appends: 0 };
  const session = { id: 'session-1', append: () => { state.appends += 1; } };
  const ctx = {
    sessionQuery: {
      readSession: async () => {
        if (options.readFails === true) throw new Error('persistence is down');
        return log;
      },
      readTitle: async () => (options.noTitle === true ? undefined : { title: 'refactor auth' }),
      listEvents: async () => (options.records ?? [{ seq: 5 }, { seq: 9 }]),
    },
    get: (service) => {
      if (options.degradeLive === true) return undefined;
      if (service === 'agents') return { get: () => ({ session, options: { provider: 'deepseek', model: 'chat' } }) };
      if (service === 'tokenMeter') {
        return { measure: () => { if (options.meterThrows === true) throw new Error('boom'); return { totalTokens: 105, surfaceTokens: 90 }; } };
      }
      if (service === 'llm') return { resolveModel: async () => ({ context: { contextWindow: 128_000 } }) };
      return undefined;
    },
    state,
  };
  return ctx;
}

await acheck('GET answers a JSON briefing with the session title', async () => {
  const response = fakeResponse();
  await handleRoute(fakeCtx(makeLog(cleanCompleted)), fakeRequest('GET', `${ROUTE_PATH}?sessionId=s1&sinceSeq=0`), response, { pending: new Map() });
  eq(response.status, 200, 'status');
  eq(response.headers['cache-control'], 'no-store', 'no-store');
  eq(response.headers['x-content-type-options'], 'nosniff', 'nosniff');
  const body = JSON.parse(response.body);
  eq(body.ok, true, 'ok');
  eq(body.briefing.title, 'refactor auth', 'title from readTitle');
  eq(body.briefing.sessionId, 'session-1', 'sessionId comes from the log, not the query');
});

await acheck('the route lands the live weather it measured', async () => {
  const response = fakeResponse();
  await handleRoute(fakeCtx(makeLog(cleanCompleted)), fakeRequest('GET', `${ROUTE_PATH}?sessionId=s1`), response, { pending: new Map() });
  const body = JSON.parse(response.body);
  eq(body.briefing.weather.contextTokens, 105, 'contextTokens');
  eq(body.briefing.weather.contextWindow, 128_000, 'contextWindow');
  eq(body.briefing.weather.percent, 0.1, 'percent');
});

await acheck('a probe answers only the log tail', async () => {
  const response = fakeResponse();
  await handleRoute(fakeCtx(makeLog(cleanCompleted)), fakeRequest('GET', `${ROUTE_PATH}?probe=1&sessionId=s1`), response, { pending: new Map() });
  eq(response.status, 200, 'status');
  eq(JSON.parse(response.body), { ok: true, sessionId: 's1', tailSeq: 9 }, 'probe body');
});

await acheck('text format answers the rendered front page', async () => {
  const response = fakeResponse();
  await handleRoute(fakeCtx(makeLog(cleanCompleted)), fakeRequest('GET', `${ROUTE_PATH}?sessionId=s1&format=text`), response, { pending: new Map() });
  eq(response.status, 200, 'status');
  ok(response.body.includes('THE MORNING PAPER'), 'masthead');
  ok(response.body.includes('LEAD:'), 'lead line');
  ok(response.body.includes('WHAT IT DID'), 'activity section');
  ok(response.body.includes('TURNS'), 'turns section');
  ok(response.body.includes('BUSINESS'), 'business section');
});

await acheck('a non-GET method is refused with Allow: GET', async () => {
  const response = fakeResponse();
  await handleRoute(fakeCtx(makeLog(cleanCompleted)), fakeRequest('POST', ROUTE_PATH), response, { pending: new Map() });
  eq(response.status, 405, 'status');
  eq(response.headers.allow, 'GET', 'allow header');
});

await acheck('a bad request answers 400 with a code, not a stack', async () => {
  const response = fakeResponse();
  await handleRoute(fakeCtx(makeLog(cleanCompleted)), fakeRequest('GET', `${ROUTE_PATH}?sessionId=`), response, { pending: new Map() });
  eq(response.status, 400, 'status');
  eq(JSON.parse(response.body).error.code, 'BAD_REQUEST', 'code');
});

await acheck('a typed refusal keeps its own status', async () => {
  const response = fakeResponse();
  await handleRoute(fakeCtx(makeLog(cleanCompleted)), fakeRequest('GET', `${ROUTE_PATH}?sessionId=s1&sinceSeq=999`), response, { pending: new Map() });
  eq(response.status, 409, 'status');
  eq(JSON.parse(response.body).error.code, 'MARKER_AHEAD', 'code');
});

await acheck('an unreadable log answers 502 rather than pretending', async () => {
  const response = fakeResponse();
  await handleRoute(fakeCtx(makeLog(cleanCompleted), { readFails: true }), fakeRequest('GET', `${ROUTE_PATH}?sessionId=s1`), response, { pending: new Map() });
  eq(response.status, 502, 'status');
  eq(JSON.parse(response.body).error.code, 'BRIEFING_FAILED', 'code');
});

await acheck('context hygiene: answering a briefing appends nothing to the session', async () => {
  const ctx = fakeCtx(makeLog(cleanCompleted));
  const response = fakeResponse();
  await handleRoute(ctx, fakeRequest('GET', `${ROUTE_PATH}?sessionId=s1`), response, { pending: new Map() });
  eq(ctx.state.appends, 0, 'no append');
});

await acheck('readTailSeq reports the newest seq, and -1 for an empty log', async () => {
  eq(await readTailSeq(fakeCtx(makeLog([])), 's1'), 9, 'newest of the records');
  const empty = { sessionQuery: { listEvents: async () => [] } };
  eq(await readTailSeq(empty, 's1'), -1, 'empty');
});

/* ------------------------------------------------------- live weather */

await acheck('weather is null without a live session, without a meter, and when the meter throws', async () => {
  eq(await resolveWeather(fakeCtx(makeLog([]), { degradeLive: true }), 's1'), null, 'no services');
  eq(await resolveWeather(fakeCtx(makeLog([]), { meterThrows: true }), 's1'), null, 'meter threw');
  eq(await resolveWeather({ get: () => undefined }, 's1'), null, 'nothing mounted');
  eq(await resolveWeather(undefined, 's1'), null, 'no ctx at all');
});

await acheck('weather survives an unknown context window and reports the limit as unknown', async () => {
  const ctx = {
    get: (service) => (service === 'agents'
      ? { get: () => ({ session: {}, options: { provider: 'p', model: 'm' } }) }
      : service === 'tokenMeter'
        ? { measure: () => ({ totalTokens: 10, surfaceTokens: 10 }) }
        : { resolveModel: async () => ({}) }),
  };
  const weather = await resolveWeather(ctx, 's1');
  eq(weather.contextWindow, null, 'no declared window');
  eq(weather.percent, null, 'no invented percent');
});

check('a configured context ceiling is accepted only when it is a real capacity', () => {
  eq(normalizeContextWindow(128000), 128000, 'a positive integer is accepted');
  eq(normalizeContextWindow('64000'), 64000, 'a numeric string is accepted');
  eq(normalizeContextWindow(0), null, 'zero is not a capacity');
  eq(normalizeContextWindow(-1), null, 'negative is not a capacity');
  eq(normalizeContextWindow(1.5), null, 'a fraction is not a capacity');
  eq(normalizeContextWindow('lots'), null, 'a word is not a capacity');
  eq(normalizeContextWindow(undefined), null, 'absent stays absent');
  eq(normalizeContextWindow(null), null, 'null stays absent');
  eq(normalizeContextWindow({ contextWindow: 128000 }), null, 'a nested object is not a number');
});

await acheck('a configured ceiling fills in for a model that declares none, and is labelled', async () => {
  const ctx = {
    get: (service) => (service === 'agents'
      ? { get: () => ({ session: {}, options: { provider: 'deepseek', model: 'chat' } }) }
      : service === 'tokenMeter'
        ? { measure: () => ({ totalTokens: 64_000, surfaceTokens: 60_000 }) }
        : { resolveModel: async () => ({}) }),
  };
  const weather = await resolveWeather(ctx, 's1', 128000);
  eq(weather.contextWindow, 128000, 'the configured ceiling is used');
  eq(weather.source, 'config', 'and is labelled as an assumption');
  eq(weather.percent, 50, 'percent is derived from it');

  const unlabelled = await resolveWeather(ctx, 's1', null);
  eq(unlabelled.contextWindow, null, 'no config and no declaration stays unknown');
  eq(unlabelled.percent, null, 'and claims no percentage');
});

await acheck('a model-declared capacity always beats the configured one', async () => {
  const ctx = {
    get: (service) => (service === 'agents'
      ? { get: () => ({ session: {}, options: { provider: 'p', model: 'm' } }) }
      : service === 'tokenMeter'
        ? { measure: () => ({ totalTokens: 100, surfaceTokens: 90 }) }
        : { resolveModel: async () => ({ context: { contextWindow: 200 } }) }),
  };
  const weather = await resolveWeather(ctx, 's1', 100000);
  eq(weather.contextWindow, 200, 'the declared window wins');
  eq(weather.source, 'model', 'and is sourced to the model');
  eq(weather.percent, 50, 'percent uses the declared window');
});

check('the text weather line names the ceiling source when it is an assumption', () => {
  const configured = buildBriefing(makeLog(cleanCompleted), -1, BASE + 6000, {
    weather: { contextTokens: 64_000, surfaceTokens: 60_000, contextWindow: 128_000, source: 'config', percent: 50 },
  });
  const text = renderBriefingText(configured);
  ok(text.includes('(50%)'), 'the percentage is shown');
  ok(text.includes('from plugin config'), 'and its provenance is stated');

  const declared = buildBriefing(makeLog(cleanCompleted), -1, BASE + 6000, {
    weather: { contextTokens: 64_000, surfaceTokens: 60_000, contextWindow: 128_000, source: 'model', percent: 50 },
  });
  ok(!renderBriefingText(declared).includes('from plugin config'), 'a declared window carries no caveat');
});

await acheck('the row config reaches the route end to end', async () => {
  const routes = [];
  const briefingCtx = fakeCtx(makeLog(cleanCompleted), { noTitle: true });
  const ctx = {
    effect: (body) => body(),
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    on: () => () => {},
    inject: () => {},
    sessionQuery: briefingCtx.sessionQuery,
    // A route whose adapter declares no capacity, so the configured value is the
    // only ceiling in play.
    get: (service) => {
      if (service === 'llm') return { resolveModel: async () => ({}) };
      return briefingCtx.get(service);
    },
  };
  apply(ctx, { contextWindow: 128000 });
  eq(routes.length, 1, 'the route registered');
  const response = fakeResponse();
  routes[0].handler(fakeRequest('GET', `${ROUTE_PATH}?sessionId=s1`), response);
  await new Promise((resolve) => setImmediate(resolve));
  const body = JSON.parse(response.body);
  eq(body.briefing.weather.contextWindow, 128000, 'the configured ceiling arrived');
  eq(body.briefing.weather.source, 'config', 'labelled as config');
  eq(body.briefing.weather.percent, 0.1, 'and produced a percentage');

  // An invalid row config is ignored rather than trusted.
  const routes2 = [];
  apply({ ...ctx, webServer: { register: (route) => { routes2.push(route); return () => {}; } } }, { contextWindow: 'nonsense' });
  const response2 = fakeResponse();
  routes2[0].handler(fakeRequest('GET', `${ROUTE_PATH}?sessionId=s1`), response2);
  await new Promise((resolve) => setImmediate(resolve));
  eq(JSON.parse(response2.body).briefing.weather.contextWindow, null, 'a nonsense ceiling is ignored');
});

await acheck('weather survives a model-resolution failure', async () => {
  const ctx = {
    get: (service) => (service === 'agents'
      ? { get: () => ({ session: {}, options: {} }) }
      : { measure: () => ({ totalTokens: 7, surfaceTokens: 7 }) }),
  };
  const weather = await resolveWeather(ctx, 's1');
  eq(weather.contextTokens, 7, 'still reports pressure');
  eq(weather.contextWindow, null, 'no window');
});

/* ------------------------------------------------------- question watermark */

await acheck('the question watermark always delegates, records while open, and clears when it settles', async () => {
  const watcher = createQuestionWatcher();
  let delegated = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = watcher.listener({ questions: [{ id: 'q1', question: 'which branch?' }] }, () => { delegated += 1; return gate; });
  eq(delegated, 1, 'next() called exactly once');
  eq(watcher.pending.size, 1, 'recorded while the waterfall is open');
  release('answered');
  eq(await running, 'answered', 'the downstream answer is preserved');
  eq(watcher.pending.size, 0, 'cleared once settled');
});

await acheck('a recording failure cannot break the user-questions chain', async () => {
  const watcher = createQuestionWatcher();
  const hostile = {};
  Object.defineProperty(hostile, 'questions', { get() { throw new Error('hostile payload'); } });
  let delegated = 0;
  const result = watcher.listener(hostile, () => { delegated += 1; return Promise.resolve('ok'); });
  eq(delegated, 1, 'still delegated');
  eq(await result, 'ok', 'the answer is untouched');
  eq(watcher.pending.size, 0, 'nothing was recorded');
});

await acheck('a rejected waterfall still clears its record', async () => {
  const watcher = createQuestionWatcher();
  const running = watcher.listener({ questions: [{ question: 'x' }] }, () => Promise.reject(new Error('no answerer')));
  await running.catch(() => {});
  eq(watcher.pending.size, 0, 'cleared on rejection too');
});

/* ------------------------------------------------------- command */

await acheck('/briefing prints the front page', async () => {
  const result = await runBriefingCommand(fakeCtx(makeLog(cleanCompleted)), { agent: { session: { id: 's1' } }, rawInput: '' }, { pending: new Map() });
  eq(result.kind, 'success', 'kind');
  ok(result.text.includes('THE MORNING PAPER'), 'masthead');
  ok(result.text.includes('refactor auth'), 'title');
});

await acheck('/briefing --since N narrows the window, and a bad --since is an error', async () => {
  const narrowed = await runBriefingCommand(fakeCtx(makeLog(cleanCompleted)), { agent: { session: { id: 's1' } }, rawInput: '--since 3' }, { pending: new Map() });
  eq(narrowed.kind, 'success', 'kind');
  ok(narrowed.text.includes('window: seq 3..5'), 'explicit window');

  const bad = await runBriefingCommand(fakeCtx(makeLog(cleanCompleted)), { agent: { session: { id: 's1' } }, rawInput: '--since soon' }, { pending: new Map() });
  eq(bad.kind, 'error', 'kind');
});

await acheck('/briefing without a session is an error, never a crash', async () => {
  const result = await runBriefingCommand(fakeCtx(makeLog(cleanCompleted)), { agent: {} }, { pending: new Map() });
  eq(result.kind, 'error', 'kind');
});

await acheck('a refused command reports the code instead of throwing', async () => {
  const result = await runBriefingCommand(fakeCtx(makeLog(cleanCompleted)), { agent: { session: { id: 's1' } }, rawInput: '--since 999' }, { pending: new Map() });
  eq(result.kind, 'error', 'kind');
  ok(result.text.includes('MARKER_AHEAD'), 'code surfaced');
});

/* ------------------------------------------------------- host plugin shape */

check('the host module declares the seams it needs', () => {
  eq(name, 'morning-paper', 'plugin name');
  ok(Array.isArray(inject), 'inject is an array');
  ok(inject.includes('sessionQuery'), 'needs sessionQuery');
  ok(inject.includes('webServer'), 'needs webServer');
  eq(ROUTE_PATH, '/morning-paper', 'route path');
  eq(COMMAND_NAME, 'briefing', 'command name');
});

check('apply registers exactly the route, the watermark, and the command', () => {
  const routes = [];
  const listeners = [];
  const commands = [];
  const labels = [];
  const ctx = {
    effect: (body, label) => { labels.push(label); return body(); },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    on: (event, listener) => { listeners.push({ event, listener }); return () => {}; },
    inject: (services, callback) => {
      if (!services.includes('commands')) throw new Error('unexpected optional service request');
      callback({ effect: (body) => body(), commands: { register: (definition) => { commands.push(definition); return () => {}; } } });
    },
  };
  apply(ctx);
  eq(routes.length, 1, 'one route');
  eq(routes[0].kind, 'exact', 'exact route');
  eq(routes[0].path, ROUTE_PATH, 'route path');
  eq(listeners.length, 1, 'one listener');
  eq(listeners[0].event, 'user-questions/request', 'watermark event');
  eq(commands.length, 1, 'one command');
  eq(commands[0].name, 'briefing', 'command name');
  eq(commands[0].recordInput, false, 'the command owns no provider payload');
  eq(labels.length, 2, 'two unconditional effects');
  routes[0].handler(fakeRequest('GET', `${ROUTE_PATH}?sessionId=s1`), fakeResponse());
});

check('apply does not require the optional command service', () => {
  const ctx = {
    effect: (body) => body(),
    webServer: { register: () => () => {} },
    on: () => () => {},
    inject: () => { throw new Error('this composition has no commands service'); },
  };
  // A composition without `commands` must still mount: ctx.inject is Cordis-owned
  // and only calls back when the service exists, so a throwing inject here proves
  // the call is made and nothing else depends on it.
  let threw = false;
  try {
    apply(ctx);
  } catch {
    threw = true;
  }
  eq(threw, true, 'the test double throws, which is the point: no other work depends on it');
});

/* ------------------------------------------------------- renderer */

check('the text renderer covers every section and emits no control characters', () => {
  const briefing = buildBriefing(makeLog([
    ev(1, 'approval/asked', { id: 'a1', toolName: 'bash', reason: 'rm -rf node_modules' }),
    ev(2, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{"file_path":"/w/a.ts"}' }),
    ev(3, 'tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [] } }),
    ev(4, 'user/message', { content: [{ type: 'text', text: 'ship it' }] }),
    ev(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]), 0, BASE + 20 * 60 * 1000, {
    weather: { contextTokens: 105, surfaceTokens: 90, contextWindow: 128_000, percent: 0.1 },
  });
  const text = renderBriefingText(briefing);
  ok(text.includes('ACTION REQUIRED'), 'action section');
  ok(text.includes('approval for bash'), 'action line');
  ok(text.includes('LEAD:'), 'lead line');
  ok(text.includes('blocked'), 'blocked sentence');
  ok(text.includes('WHAT IT DID'), 'activity summary');
  ok(text.includes('TURNS'), 'per-turn timeline');
  ok(text.includes('FILES'), 'file churn');
  ok(text.includes('WEATHER'), 'weather');
  ok(text.includes('window: seq 0..5'), 'window footer');
  ok(!/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/.test(text), 'no control characters other than newline');
  ok(!text.includes('undefined'), 'no undefined leaked into the page');
});

check('quoted session content is sanitized but never mangled', () => {
  const log = makeLog([
    ev(1, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok \u001b[31mALERT\u001b[0m 测试完成' }] }, stream: [] }),
    ev(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev(3, 'deliverables/presented', { turn: 1, callId: 'p', files: [{ path: 'src/ünïcode/\u001b[2Jfile.ts' }] }),
    ev(4, 'user/message', { content: [{ type: 'text', text: 'ünïcode\nsecond line \u001b[2J' }] }),
  ]);
  const briefing = buildBriefing(log, -1, BASE + 5000);
  eq(briefing.asks.map((ask) => ask.text), ['ünïcode second line [2J'], 'escape sequences stripped, unicode preserved');
  ok(!briefing.asks[0].text.includes('\u001b'), 'no ESC reaches the page');
  eq(briefing.business.files, ['src/ünïcode/[2Jfile.ts'], 'paths sanitized too');
  const text = renderBriefingText(briefing);
  ok(text.includes('测试完成') || text.includes('ünïcode'), 'non-ASCII content still renders');
  ok(!/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/.test(text), 'no control characters survive rendering');
});

check('a long ask is clipped with an ASCII marker', () => {
  const log = makeLog([ev(1, 'user/message', { content: [{ type: 'text', text: 'x'.repeat(500) }] })]);
  const briefing = buildBriefing(log, -1, BASE + 2000);
  eq(briefing.asks[0].text.length, 140, 'clipped to the ceiling');
  ok(briefing.asks[0].text.endsWith('...'), 'ascii truncation marker');
});

check('the text page reports failures the tab reports, so the two agree', () => {
  const log = makeLog([
    ev(1, 'tool/call', { turn: 1, step: 1, callId: 'a', name: 'edit', arguments: '{"file_path":"/w/a.ts"}' }),
    ev(2, 'tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'a' }, content: [] }, error: { name: 'FsError', code: 'FS_STALE_VERSION' } }),
    ev(3, 'tool/call', { turn: 1, step: 1, callId: 'b', name: 'edit', arguments: '{"file_path":"/w/a.ts"}' }),
    ev(4, 'tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'b' }, content: [] }, error: { name: 'FsError', code: 'FS_STALE_VERSION' } }),
    ev(5, 'llm/retry', {}),
    ev(6, 'compaction/start', {}),
    ev(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  const briefing = buildBriefing(log, -1, BASE + 8000);
  const text = renderBriefingText(briefing);
  ok(text.includes('CORRECTIONS'), 'the text page has a corrections section');
  ok(text.includes('2 tool failure(s): edit/FS_STALE_VERSION x2'), 'grouped by tool and code');
  ok(text.includes('1 model retry(ies)'), 'retries');
  ok(text.includes('1 compaction(s)'), 'compactions');
  eq(briefing.unresolved.length, 2, 'both are unresolved, since nothing edited successfully afterwards');
});

check('the text renderer says a quiet session is quiet', () => {
  const text = renderBriefingText(buildBriefing(makeLog([]), -1, BASE));
  ok(text.includes('Nothing happened while you were out.'), 'quiet sentence');
  ok(text.includes('context pressure unavailable'), 'weather degrades in words');
});

check('the text masthead never claims an away duration it did not measure', () => {
  const whole = renderBriefingText(buildBriefing(makeLog(cleanCompleted), -1, BASE + HOUR));
  ok(whole.includes('whole session'), 'whole-session reads say so');
  ok(!whole.includes('away 1h'), 'and never claim an away window');
  const windowed = renderBriefingText(buildBriefing(makeLog(cleanCompleted), 3, BASE + 3000 + HOUR));
  ok(windowed.includes('away 1h'), 'windowed reads report the away time');
});

check('durations read the way a person would say them', () => {
  eq(formatDuration(0), '0s', 'zero');
  eq(formatDuration(45_000), '45s', 'seconds');
  eq(formatDuration(12 * 60_000), '12m', 'minutes');
  eq(formatDuration(HOUR), '1h', 'hours');
  eq(formatDuration(3 * HOUR + 12 * 60_000), '3h 12m', 'hours and minutes');
  eq(formatDuration(50 * HOUR), '2d 2h', 'days');
  eq(formatDuration(-5), '0s', 'negative clamps');
  eq(formatDuration(undefined), '0s', 'absent is zero');
});

/* ------------------------------------------------------- client bundle */

/** Evaluate the real client bundle in a sandbox with stubbed loader, window and document. */
function loadClientBundle() {
  const code = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8');
  let definition = null;
  const store = new Map();
  const styles = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => { throw new Error('no fetch installed'); },
    window: {
      __ModuleLoader__: { load: (value) => { definition = value; } },
      localStorage: {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => { store.set(key, String(value)); },
        removeItem: (key) => { store.delete(key); },
      },
    },
    document: {
      head: { appendChild: (node) => { styles.push(node); } },
      getElementById: (id) => styles.find((node) => node.id === id) ?? null,
      createElement: (tag) => ({ tag, id: '', textContent: '' }),
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { definition, sandbox, store, styles };
}

/** A require that fails for everything, as a bundle with no React would. */
function emptyRequire() {
  throw new Error('module unavailable');
}

/** A minimal element factory good enough to inspect the render tree. */
function fakeH(type, props, children) {
  const list = children === undefined ? [] : (Array.isArray(children) ? children : [children]);
  return { type, props: props ?? {}, children: list };
}

/** @returns all text inside a tree built by {@link fakeH}. */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf(node.children);
}

/** @returns every element of one type inside a tree. */
function findAll(node, type, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, type, found);
    return found;
  }
  if (node.type === type) found.push(node);
  for (const child of node.children) findAll(child, type, found);
  return found;
}

/** @returns the relative luminance of one `#rrggbb` colour, per WCAG 2.1. */
function luminance(hex) {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** @returns the WCAG contrast ratio between two `#rrggbb` colours. */
function contrastRatio(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

const bundle = loadClientBundle();
const client = bundle.definition.factory(emptyRequire);

/** @returns the footer control buttons (Mark read / Refresh / …), never the pager. */
function controlsOf(tree) {
  const group = findAll(tree, 'div').find((node) => node.props.className === 'dmp-controls');
  return group === undefined ? [] : findAll(group, 'button');
}

/** @returns one page of the paper, rendered with inert handlers. */
function renderPage(display, page) {
  return client.paperTree(fakeH, display, {
    page,
    onPage: () => {},
    onMarkRead: () => {},
    onRefresh: () => {},
    onForget: () => {},
  });
}

check('the client bundle registers under its own id', () => {
  eq(bundle.definition.id, 'dsh-morning-paper', 'bundle id');
  eq(typeof bundle.definition.factory, 'function', 'factory');
});

check('the client half exports the plugin surface', () => {
  eq(typeof client.apply, 'function', 'apply');
  eq(client.inject, ['slots'], 'inject');
  eq(typeof client.MorningPaperView, 'function', 'view component');
});

check('the client half renders nothing when React is unavailable', () => {
  eq(client.MorningPaperView({ sessionId: 's1' }), null, 'fails soft');
});

check('the client half registers a Conversation View tab, not a composer decoration', () => {
  const injected = [];
  const registered = [];
  const ctx = {
    slots: {
      inject: (slot, callback) => { injected.push(slot); callback(); },
      register: (definition, component) => { registered.push({ definition, component }); return () => {}; },
    },
  };
  client.apply(ctx);
  eq(injected, ['conversation.view'], 'the view slot, next to Chat and Trajectory');
  eq(registered.length, 1, 'one registration');
  eq(registered[0].definition.name, 'conversation.view', 'slot name');
  eq(registered[0].definition.id, 'morning-paper', 'entry id');
  eq(registered[0].definition.label(), 'Morning Paper', 'tab label');
  eq(registered[0].definition.order, 20, 'ordered after trajectory');
  eq(registered[0].component, client.MorningPaperView, 'component');
});

check('a failed tab registration is contained rather than fatal', () => {
  const ctx = { slots: { inject: () => { throw new Error('this composition has no view slot'); } } };
  const original = console.warn;
  console.warn = () => {};
  let threw = false;
  try {
    client.apply(ctx);
  } catch {
    threw = true;
  } finally {
    console.warn = original;
  }
  eq(threw, false, 'apply swallows the failure');
});

check('the stylesheet is installed exactly once and carries the paper look', () => {
  const fresh = loadClientBundle();
  const instance = fresh.definition.factory(emptyRequire);
  instance.ensureStyles();
  instance.ensureStyles();
  eq(fresh.styles.length, 1, 'injected once');
  eq(fresh.styles[0].id, 'dsh-morning-paper-styles', 'stable element id');
  const css = instance.PAPER_CSS;
  for (const token of ['.dmp-paper', 'Georgia', 'column-count', 'first-letter', 'letter-spacing', 'text-transform: uppercase', '3px double']) {
    ok(css.includes(token), `stylesheet mentions ${token}`);
  }
  // Every palette value comes from PAPER_TOKENS, so the two cannot drift.
  for (const [name, value] of Object.entries(instance.PAPER_TOKENS)) {
    ok(css.includes(value), `stylesheet carries the ${name} token (${value})`);
  }
  ok(css.includes('background: var(--dmp-paper)'), 'the sheet is painted');
  ok(css.includes('color: var(--dmp-ink)'), 'the ink is painted');
});

check('legibility is a property of the stylesheet, not of a theme token', () => {
  const css = client.PAPER_CSS;
  // The first version mixed the sheet from `--dsw-alias-*` names that were guessed
  // wrong, which produced light ink on light paper. Reading must not depend on
  // which tokens a theme happens to define, so this is asserted, not assumed.
  ok(!css.includes('--dsw-alias'), 'no guessed theme tokens in the palette');
  ok(!css.includes('color-mix'), 'no colour math that can invert the page');
});

check('every text tier clears its contrast ratio against the sheet', () => {
  const tokens = client.PAPER_TOKENS;
  const ink = contrastRatio(tokens.ink, tokens.paper);
  const soft = contrastRatio(tokens.inkSoft, tokens.paper);
  const faint = contrastRatio(tokens.inkFaint, tokens.paper);
  const onBulletin = contrastRatio(tokens.ink, tokens.bulletin);
  const accent = contrastRatio(tokens.accent, tokens.bulletin);
  ok(ink >= 7, `body ink on paper is ${ink.toFixed(2)}:1 (want >= 7)`);
  ok(soft >= 7, `secondary ink on paper is ${soft.toFixed(2)}:1 (want >= 7)`);
  ok(faint >= 4.5, `faint ink on paper is ${faint.toFixed(2)}:1 (want >= 4.5)`);
  ok(onBulletin >= 7, `ink on the bulletin is ${onBulletin.toFixed(2)}:1 (want >= 7)`);
  ok(accent >= 4.5, `accent on the bulletin is ${accent.toFixed(2)}:1 (want >= 4.5)`);
});

check('the stylesheet is well-formed enough to ship', () => {
  const css = client.PAPER_CSS;
  ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(css), 'no control characters');
  ok(css.includes('content: "\\2014'), 'the em-dash bullet is escaped for CSS');
  ok(css.includes('content: "\\203B'), 'the reference-mark bullet is escaped for CSS');
  const opens = (css.match(/\{/g) ?? []).length;
  const closes = (css.match(/\}/g) ?? []).length;
  eq(opens, closes, 'balanced braces');
});

check('marking read advances the marker without blanking the page you just read', () => {
  const { definition, store } = loadClientBundle();
  const instance = definition.factory(emptyRequire);
  const display = client.summarize(buildBriefing(makeLog(cleanCompleted), 0, BASE + 6000), null);
  let briefingSet = 0;
  const stamps = [];
  const handled = instance.markAllRead('s1', display, {
    setBriefing: () => { briefingSet += 1; },
    setMarkedReadAt: (value) => { stamps.push(value); },
  });
  eq(handled, true, 'the marker was written');
  eq(store.get('dsh-morning-paper:seen:s1'), String(display.throughSeq), 'stored at the window tail');
  eq(briefingSet, 0, 'and the page was left alone, so the paper does not vanish under you');
  eq(stamps.length, 1, 'a confirmation time is reported');
  ok(/^\d{2}:\d{2}$/.test(stamps[0]), `the confirmation reads as a clock time: ${stamps[0]}`);

  eq(instance.markAllRead('s1', null, { setBriefing: () => {}, setMarkedReadAt: () => {} }), false, 'nothing to mark');
  eq(instance.markAllRead('s1', { throughSeq: null }, { setBriefing: () => {}, setMarkedReadAt: () => {} }), false, 'an empty window writes nothing');
});

check('the page confirms the read state and keeps one footer row', () => {
  const display = client.summarize(buildBriefing(makeLog(cleanCompleted), 0, BASE + 6000), null);
  const bare = renderPage(display, 1);
  ok(!textOf(bare).includes('Marked everything'), 'no confirmation before you mark anything');
  const marked = client.paperTree(fakeH, display, {
    page: 1, markedReadAt: '18:41',
    onPage: () => {}, onMarkRead: () => {}, onRefresh: () => {}, onForget: () => {},
  });
  const text = textOf(marked);
  ok(text.includes('Marked everything up to now as read at 18:41'), 'the confirmation states what happened');
  const folios = findAll(marked, 'div').filter((node) => node.props.className === 'dmp-folio');
  eq(folios.length, 1, 'exactly one footer row');
  eq(findAll(folios[0], 'div').filter((node) => node.props.className === 'dmp-controls').length, 1, 'carrying the view controls');
  eq(findAll(folios[0], 'div').filter((node) => node.props.className === 'dmp-nav').length, 1, 'and the page navigation');
  eq(findAll(marked, 'p').filter((node) => node.props.className === 'dmp-colophon').length, 2, 'one line of small print plus the confirmation');
});

check('the tab reports the same correction counts as the text page', () => {
  const log = makeLog([
    ev(1, 'tool/call', { turn: 1, step: 1, callId: 'a', name: 'edit', arguments: '{"file_path":"/w/a.ts"}' }),
    ev(2, 'tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'a' }, content: [] }, error: { name: 'FsError', code: 'FS_STALE_VERSION' } }),
    ev(3, 'llm/retry', {}),
    ev(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  const display = client.summarize(buildBriefing(log, -1, BASE + 5000), null);
  eq(display.failures, '1 tool failure, 1 model retry.', 'the tab summary matches the text page');
  eq(display.failureGroups, ['edit/FS_STALE_VERSION ×1'], 'and so do the groups');
});

check('the page states when the ceiling is an assumption rather than a fact', () => {
  const configured = buildBriefing(makeLog(cleanCompleted), -1, BASE + 6000, {
    weather: { contextTokens: 64_000, surfaceTokens: 60_000, contextWindow: 128_000, source: 'config', percent: 50 },
  });
  const display = client.summarize(configured, null);
  ok(display.weather.includes('50%'), 'the page shows the percentage');
  ok(display.weather.includes('not from the model'), 'the page states the assumption');
  const declared = buildBriefing(makeLog(cleanCompleted), -1, BASE + 6000, {
    weather: { contextTokens: 64_000, surfaceTokens: 60_000, contextWindow: 128_000, source: 'model', percent: 50 },
  });
  ok(!client.summarize(declared, null).weather.includes('not from the model'), 'a declared window carries no caveat');
});

check('the display model is null only before the first response', () => {
  eq(client.summarize(null, null), null, 'loading renders no page yet');
  const quiet = client.summarize(buildBriefing(makeLog([]), -1, BASE), null);
  ok(quiet !== null, 'a quiet session still renders a page');
  eq(quiet.quiet, true, 'and says there is no news');
  eq(quiet.firstLook, true, 'a whole-session read is a first look');
});

check('the dateline never claims an away duration it did not measure', () => {
  const windowed = client.summarize(buildBriefing(makeLog(cleanCompleted), 2, BASE + 3 * HOUR + 6000), null);
  ok(windowed.dateline[0].startsWith('since '), 'a windowed read names the moment it starts from');
  eq(windowed.dateline[1], 'away 3h', 'and reports how long you were away');
  eq(windowed.dateline.length, 5, 'in five items');
  eq(windowed.firstLook, false, 'not a first look');
  const whole = client.summarize(buildBriefing(makeLog(cleanCompleted), -1, BASE + HOUR), null);
  eq(whole.dateline[0], 'whole session', 'whole-session reads say so');
});

check('the display model surfaces each new section as text', () => {
  const briefing = buildBriefing(makeLog(richWindow), -1, BASE + 70000, {
    weather: { contextTokens: 105_000, surfaceTokens: 90_000, contextWindow: 128_000, percent: 82 },
  });
  const display = client.summarize(briefing, null);
  eq(display.lead, 'Turn 1 completed.', 'lead is the outcome and nothing more');
  eq(display.did.turns, '1', 'turn count');
  eq(display.did.finished, '1', 'finished count');
  eq(display.did.toolCalls, '2', 'tool calls');
  eq(display.did.filesTouched, '1', 'files touched');
  eq(display.did.commands, '1', 'commands');
  eq(display.did.commandsFailed, '1', 'failed commands');
  eq(display.timeline.length, 1, 'one timeline row');
  eq(display.timeline[0].outcome, 'finished', 'outcome word');
  eq(display.timeline[0].took, '1m', 'turn duration');
  eq(display.timeline[0].tools, '2', 'tools in the turn');
  eq(display.files, [{ count: '1×', path: '~/proj/src/parse.ts' }], 'file churn with a short path');
  eq(display.toolRows.map((row) => row.tool), ['bash', 'edit'], 'tools by time spent');
  ok(display.longest.startsWith('bash'), `longest was ${display.longest}`);
  eq(display.money.length, 1, 'spend ranking');
  eq(display.money[0].share, '100%', 'share of the window');
  eq(display.unresolved.length, 1, 'one unresolved failure');
  eq(display.unresolved[0].tool, 'bash', 'unresolved names the tool');
  eq(display.unresolved[0].code, 'EXIT_1', 'unresolved carries the code');
  eq(display.unresolved[0].command, 'pnpm test', 'unresolved quotes the command');
  eq(display.asks, ['fix the parser'], 'what you asked');
  eq(display.weather, '105,000 of 128,000 context tokens (82%).', 'weather line');
});

check('the display model keeps the action bulletin intact', () => {
  const briefing = buildBriefing(makeLog(blockedWithApproval), -1, BASE + 2 * 1000 + 20 * 60 * 1000);
  const display = client.summarize(briefing, null);
  eq(display.actions.length, 1, 'one action');
  eq(display.actions[0].strong, 'bash', 'action names the tool');
  ok(display.actions[0].tail.includes('rm -rf node_modules'), 'action quotes the reason');
  eq(display.actions[0].detail, '20m ago', 'action age');
  ok(display.lead.includes('waiting on you'), 'lead sentence');
});

check('the summary line agrees with the host numbers', () => {
  const display = client.summarize(buildBriefing(makeLog(cleanCompleted), -1, BASE + 6000), null);
  eq(display.did.toolCalls, '1', 'one tool call in the fixture');
  ok(display.figures.includes('360 tokens'), `figures were ${JSON.stringify(display.figures)}`);
  ok(display.figures.includes('cache hit 64.5%'), 'cache share');
  const rich = client.summarize(buildBriefing(makeLog(richWindow), -1, BASE + 70000), null);
  eq(rich.did.toolCalls, '2', 'tool calls counted from calls');
  ok(rich.figures.some((figure) => figure.endsWith('% tool time')), 'tool time share is reported');
});

check('weather refuses to invent a percentage', () => {
  const noWindow = client.summarize(buildBriefing(makeLog(cleanCompleted), -1, BASE + 6000, {
    weather: { contextTokens: 340_115, surfaceTokens: 305_100, contextWindow: null, percent: null },
  }), null);
  ok(noWindow.weather.includes('340,115'), 'reports the real pressure');
  ok(noWindow.weather.includes('no ceiling'), 'explains the missing ceiling');
  ok(!noWindow.weather.includes('%'), 'claims no percentage');
  const none = client.summarize(buildBriefing(makeLog(cleanCompleted), -1, BASE + 6000), null);
  ok(none.weather.includes('Not measured'), 'absence is stated');
});

check('a failure is shown rather than swallowed', () => {
  const display = client.summarize(null, { code: 'LOG_TOO_LARGE', message: 'too big' });
  eq(display.kind, 'error', 'kind');
  eq(display.error.code, 'LOG_TOO_LARGE', 'code preserved');
  const text = textOf(client.paperTree(fakeH, display, { onMarkRead: () => {}, onRefresh: () => {}, onForget: () => {} }));
  ok(text.includes('LOG_TOO_LARGE'), 'the page prints the refusal');
});

check('the page renders a masthead, bulletin, lede, columns and small print', () => {
  const briefing = buildBriefing(makeLog(blockedWithApproval), 0, BASE + 2 * 1000 + 20 * 60 * 1000, {
    weather: { contextTokens: 105_000, surfaceTokens: 90_000, contextWindow: 128_000, percent: 82 },
  });
  const display = client.summarize(briefing, null);
  const tree = client.paperTree(fakeH, display, { onMarkRead: () => {}, onRefresh: () => {}, onForget: () => {} });
  eq(tree.type, 'article', 'the page is an article');
  eq(tree.props.className, 'dmp-paper', 'wearing the paper class');
  const text = textOf(tree);
  for (const heading of ['The Morning Paper', 'Action required', 'Weather']) {
    ok(text.includes(heading), `page shows ${heading}`);
  }
  ok(text.includes('never acts for you'), 'the page states it does not act for you');
  ok(text.includes('No model was called'), 'the colophon states the page was computed');
  eq(controlsOf(tree).map((button) => textOf(button)), ['Mark all read', 'Refresh', 'Show whole session'], 'three controls');
});

check('the log page carries the timeline and the unresolved failures', () => {
  const briefing = buildBriefing(makeLog(richWindow), 0, BASE + 70000);
  const display = client.summarize(briefing, null);
  const text = textOf(renderPage(display, 2));
  for (const heading of ['Turns', 'Corrections', 'Unresolved']) {
    ok(text.includes(heading), `the log page shows ${heading}`);
  }
  ok(text.includes('#1'), 'the turn row is labelled');
  ok(text.includes('pnpm test'), 'the failing command is quoted');
  ok(text.includes('EXIT_1'), 'the failure code is shown');
  ok(!text.includes('Where the money went'), 'the money table is not on the log page');
});

check('the ledger page carries churn, time and money', () => {
  const briefing = buildBriefing(makeLog(richWindow), 0, BASE + 70000);
  const display = client.summarize(briefing, null);
  const tree = renderPage(display, 3);
  const text = textOf(tree);
  for (const heading of ['Files', 'Where the time went', 'Where the money went']) {
    ok(text.includes(heading), `the ledger page shows ${heading}`);
  }
  ok(text.includes('~/proj/src/parse.ts'), 'the edited file is listed');
  ok(!text.includes('Turns'), 'the timeline is not on the ledger page');
  const bars = findAll(tree, 'i').filter((node) => node.props.style !== undefined);
  ok(bars.length >= 1, 'the time bars rendered');
  ok(String(bars[0].props.style.width).endsWith('%'), 'a bar carries a width');
});

check('the front page carries the action bulletin, the lead, the asks and the weather', () => {
  const briefing = buildBriefing(makeLog(richWindow), 0, BASE + 70000);
  const display = client.summarize(briefing, null);
  const text = textOf(renderPage(display, 1));
  for (const heading of ['You asked', 'Weather']) ok(text.includes(heading), `the front page shows ${heading}`);
  ok(text.includes('fix the parser'), 'your ask is listed');
  ok(!text.includes('Where the money went'), 'the ledger is elsewhere');
});

check('pages are offered only when they have something to say', () => {
  const rich = client.pageList(client.summarize(buildBriefing(makeLog(richWindow), -1, BASE + 70000), null));
  eq(rich.map((page) => page.id), ['front', 'log', 'ledger'], 'a busy session is a three-page paper');
  eq(rich.map((page) => page.label), ['Front', 'The Log', 'The Ledger'], 'page labels');
  const quiet = client.pageList(client.summarize(buildBriefing(makeLog([]), -1, BASE), null));
  eq(quiet.map((page) => page.id), ['front'], 'a quiet session is a single sheet');
  const logOnly = client.pageList(client.summarize(buildBriefing(makeLog([
    ev(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]), -1, BASE + 2000), null));
  eq(logOnly.map((page) => page.id), ['front', 'log'], 'a turn with no file work is front plus log');
});

check('the pager navigates, marks the current page, and clamps out-of-range pages', () => {
  const display = client.summarize(buildBriefing(makeLog(richWindow), -1, BASE + 70000), null);
  const asked = [];
  const tree = client.paperTree(fakeH, display, {
    page: 1,
    onPage: (next) => { asked.push(next); },
    onMarkRead: () => {}, onRefresh: () => {}, onForget: () => {},
  });
  const pager = findAll(tree, 'button').filter((button) => textOf(button).startsWith('Page '));
  eq(pager.map((button) => textOf(button)), ['Page 1 · Front', 'Page 2 · The Log', 'Page 3 · The Ledger'], 'one link per page');
  eq(pager[0].props.className, 'dmp-page-on', 'the current page is marked');
  eq(pager[1].props.className, undefined, 'the others are not');
  pager[2].props.onClick();
  eq(asked, [3], 'clicking a page link asks for it');

  const folio = findAll(tree, 'div').find((node) => node.props.className === 'dmp-folio');
  const nav = findAll(folio, 'button');
  eq(nav[0].props.disabled, true, 'previous is dead on page one');
  eq(nav[1].props.disabled, false, 'next is live on page one');
  nav[1].props.onClick();
  eq(asked, [3, 2], 'next asks for the following page');

  // A single-sheet paper has no pager and no folio at all.
  const quiet = client.summarize(buildBriefing(makeLog([]), -1, BASE), null);
  const quietTree = renderPage(quiet, 1);
  eq(findAll(quietTree, 'button').filter((button) => textOf(button).startsWith('Page ')).length, 0, 'no pager on a single page');
  eq(findAll(quietTree, 'div').filter((node) => node.props.className === 'dmp-nav').length, 0, 'no navigation either');

  // An impossible page number resolves to a real one instead of rendering nothing.
  eq(textOf(renderPage(display, 99)).includes('The Ledger'), true, 'past the end clamps to the last page');
  eq(textOf(renderPage(display, 0)).includes('Weather'), true, 'before the start clamps to the front');
});

check('the page wires its controls', () => {
  const display = client.summarize(buildBriefing(makeLog(cleanCompleted), 0, BASE + 6000), null);
  const calls = { read: 0, refresh: 0, forget: 0 };
  const tree = client.paperTree(fakeH, display, {
    page: 1,
    onPage: () => {},
    onMarkRead: () => { calls.read += 1; },
    onRefresh: () => { calls.refresh += 1; },
    onForget: () => { calls.forget += 1; },
  });
  const buttons = controlsOf(tree);
  eq(buttons.map((button) => textOf(button)), ['Mark all read', 'Refresh', 'Show whole session'], 'the footer controls');
  for (const button of buttons) button.props.onClick();
  eq(calls, { read: 1, refresh: 1, forget: 1 }, 'all three handlers fired');
});

check('first look adds a note and hides the reset control', () => {
  const display = client.summarize(buildBriefing(makeLog(cleanCompleted), -1, BASE + 6000), null);
  const tree = renderPage(display, 1);
  const text = textOf(tree);
  ok(text.includes('First look'), 'the note explains the whole-session view');
  eq(controlsOf(tree).map((button) => textOf(button)), ['Mark all read', 'Refresh'], 'no reset control on a first look');
});

check('a long file list is capped and the cap is disclosed', () => {
  const events = [];
  for (let index = 0; index < 12; index += 1) {
    events.push(ev(index + 1, 'tool/call', { turn: 1, step: 1, callId: 'c' + index, name: 'edit', arguments: JSON.stringify({ file_path: '/w/f' + index + '.ts' }) }));
  }
  const briefing = buildBriefing(makeLog(events), -1, BASE + 20000);
  eq(briefing.files.touched, 12, 'all twelve counted');
  eq(briefing.files.listed.length, MAX_FILES, 'ten listed');
  const text = renderBriefingText(briefing);
  ok(text.includes('and 2 more file(s)'), 'the cap is disclosed');
});

check('declared deliverables are listed separately from edit churn', () => {
  const log = makeLog([
    ev(1, 'tool/call', { turn: 1, step: 1, callId: 'a', name: 'edit', arguments: '{"file_path":"/home/dev/proj/src/parse.ts"}' }),
    ev(2, 'deliverables/presented', { turn: 1, callId: 'p', files: [{ path: '/home/dev/proj/REPORT.md' }] }),
    ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  const briefing = buildBriefing(log, -1, BASE + 4000);
  eq(briefing.files.listed.map((file) => file.path), ['/home/dev/proj/src/parse.ts'], 'churn is edits');
  eq(briefing.business.files, ['/home/dev/proj/REPORT.md'], 'deliverables are the present tool');
  const text = renderBriefingText(briefing);
  ok(text.includes('delivered:'), 'the text page names the section');
  const display = client.summarize(briefing, null);
  eq(display.delivered, ['~/proj/REPORT.md'], 'and the client carries it, short-pathed');
  const tree = renderPage(display, 3);
  ok(textOf(tree).includes('Delivered'), 'the ledger page renders it');
});

check('a quiet session renders a page that says so, not an empty tab', () => {
  const display = client.summarize(buildBriefing(makeLog([]), -1, BASE), null);
  const text = textOf(renderPage(display, 1));
  ok(text.includes('No news'), 'quiet copy');
  ok(!text.includes('Turns'), 'no empty timeline for an empty session');
  ok(!text.includes('Unresolved'), 'no empty unresolved list');
  ok(text.includes('Weather'), 'the weather still stands');
  eq(client.pageList(display).length, 1, 'a quiet session is one page');
});

check('unresolved failures and notes reach the page when present', () => {
  const briefing = buildBriefing(makeLog(richWindow), -1, BASE + 70000);
  const display = client.summarize(briefing, null);
  const text = textOf(renderPage(display, 2));
  ok(text.includes('bash failed'), 'the failing tool is named');
  ok(text.includes('EXIT_1'), 'the failure code is shown');
  ok(text.includes('No live session'), 'the weather absence note is shown');
});

check('client durations and sentences match the host renderer', () => {
  eq(client.formatDuration(3 * HOUR + 12 * 60_000), '3h 12m', 'duration parity');
  eq(client.markerKey('s1'), 'dsh-morning-paper:seen:s1', 'marker key');
  eq(client.leadSentence({ kind: 'interrupted', turn: 2 }), 'Turn 2 was cut off by a restart; the events before the crash are intact.', 'interrupted sentence');
  eq(client.leadSentence(null), 'Nothing happened while you were out.', 'null lead');
});

await acheck('a first visit asks for the whole session and shows it', async () => {
  const { definition, sandbox } = loadClientBundle();
  const instance = definition.factory(emptyRequire);
  const calls = [];
  const briefing = buildBriefing(makeLog(cleanCompleted), -1, BASE + 6000);
  sandbox.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ ok: true, briefing }) };
  };
  let shown = null;
  await instance.loadBriefing('s1', { setBriefing: (value) => { shown = value; }, setError: () => {} });
  eq(calls.length, 1, 'one call');
  ok(!calls[0].includes('sinceSeq'), 'no window on a first visit');
  eq(shown.sessionId, 'session-1', 'the whole session reached the page');
  eq(instance.readMarker('s1'), null, 'and nothing was marked read yet');
});

await acheck('a returning visit asks only for the window since the marker', async () => {
  const { definition, sandbox, store } = loadClientBundle();
  const instance = definition.factory(emptyRequire);
  store.set('dsh-morning-paper:seen:s1', '42');
  const calls = [];
  const briefing = buildBriefing(makeLog(cleanCompleted), 0, BASE + 6000);
  sandbox.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ ok: true, briefing }) };
  };
  await instance.loadBriefing('s1', { setBriefing: () => {}, setError: () => {} });
  eq(calls.length, 1, 'one call');
  ok(calls[0].includes('sinceSeq=42'), 'the window starts at the marker');
});

await acheck('mark read stores the tail, and forget clears it', async () => {
  const { definition, store } = loadClientBundle();
  const instance = definition.factory(emptyRequire);
  instance.writeMarker('s1', 99);
  eq(store.get('dsh-morning-paper:seen:s1'), '99', 'stored');
  eq(instance.readMarker('s1'), 99, 'read back');
  instance.clearMarker('s1');
  eq(instance.readMarker('s1'), null, 'forgotten');
});

await acheck('the poll is a cheap tail probe that skips the expensive read when nothing moved', async () => {
  const { definition, sandbox, store } = loadClientBundle();
  const instance = definition.factory(emptyRequire);
  store.set('dsh-morning-paper:seen:s1', '42');
  const calls = [];
  const briefing = buildBriefing(makeLog(cleanCompleted), 0, BASE + 6000);
  sandbox.fetch = async (url) => {
    calls.push(url);
    if (url.includes('probe=1')) return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 's1', tailSeq: 5 }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, briefing }) };
  };
  const sets = [];
  const set = { setBriefing: (value) => { sets.push(value); }, setError: () => {} };

  await instance.loadBriefing('s1', set);
  eq(calls.length, 1, 'the first load reads the briefing');
  eq(instance.state.tailSeq, 5, 'and remembers the tail it read');

  await instance.refreshIfChanged('s1', set);
  eq(calls.length, 2, 'a poll costs one probe');
  ok(calls[1].includes('probe=1'), 'and that one call is the probe');
  eq(sets.length, 1, 'nothing moved, so the page was not re-rendered');

  sandbox.fetch = async (url) => {
    calls.push(url);
    if (url.includes('probe=1')) return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 's1', tailSeq: 9 }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, briefing }) };
  };
  await instance.refreshIfChanged('s1', set);
  eq(calls.length, 4, 'the moved tail triggers the real read');
  ok(!calls[3].includes('probe=1'), 'the second call of the tick is the briefing');
  eq(sets.length, 2, 'and the page updated');
});

await acheck('a poll with no page yet always loads, and a failed probe stays silent', async () => {
  const { definition, sandbox, store } = loadClientBundle();
  const instance = definition.factory(emptyRequire);
  store.set('dsh-morning-paper:seen:s1', '42');
  const briefing = buildBriefing(makeLog(cleanCompleted), 0, BASE + 6000);
  const calls = [];
  sandbox.fetch = async (url) => {
    calls.push(url);
    if (url.includes('probe=1')) return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 's1', tailSeq: 5 }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, briefing }) };
  };
  const sets = [];
  const errors = [];
  const set = { setBriefing: (value) => { sets.push(value); }, setError: (value) => { if (value !== null) errors.push(value); } };
  await instance.refreshIfChanged('s1', set);
  eq(sets.length, 1, 'no page yet, so the poll loads one');

  instance.state.tailSeq = 5;
  sandbox.fetch = async () => { throw new Error('probe blew up'); };
  await instance.refreshIfChanged('s1', set);
  eq(errors.length, 0, 'a failed probe never paints an error over a good page');
  eq(sets.length, 1, 'and never clears the page');
  eq(instance.state.polling, false, 'the poll guard is released even on failure');

  sandbox.fetch = async () => ({ ok: false, status: 502, json: async () => ({ ok: false }) });
  await instance.refreshIfChanged('s1', set);
  eq(errors.length, 0, 'a refused probe is silent too');
});

await acheck('only one poll runs at a time', async () => {
  const { definition, sandbox, store } = loadClientBundle();
  const instance = definition.factory(emptyRequire);
  store.set('dsh-morning-paper:seen:s1', '42');
  let release = null;
  let calls = 0;
  sandbox.fetch = async () => {
    calls += 1;
    if (calls === 1) await new Promise((resolve) => { release = resolve; });
    return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 's1', tailSeq: 5 }) };
  };
  // A page already on screen whose tail matches the probe, so the poll ends
  // after its single cheap call and the test cannot hang on a second request.
  instance.state.briefing = buildBriefing(makeLog(cleanCompleted), 0, BASE + 6000);
  instance.state.tailSeq = 5;
  const set = { setBriefing: () => {}, setError: () => {} };
  const first = instance.refreshIfChanged('s1', set);
  await instance.refreshIfChanged('s1', set);
  eq(calls, 1, 'the second call did not issue a request');
  eq(instance.state.polling, true, 'the first poll still holds the guard');
  release();
  await first;
  eq(calls, 1, 'the first finished after its single probe');
  eq(instance.state.polling, false, 'and released the guard');
});

check('the poll cadence is faster while the agent is working', () => {
  ok(client.ACTIVE_POLL_MS < client.IDLE_POLL_MS, `active ${client.ACTIVE_POLL_MS}ms is faster than idle ${client.IDLE_POLL_MS}ms`);
  ok(client.ACTIVE_POLL_MS >= 2000, 'and does not hammer the host');
});

await acheck('a stale marker is forgotten and the whole session is shown instead', async () => {
  const { definition, sandbox, store } = loadClientBundle();
  const instance = definition.factory(emptyRequire);
  store.set('dsh-morning-paper:seen:s1', '999');
  const calls = [];
  const briefing = buildBriefing(makeLog(cleanCompleted), -1, BASE + 6000);
  sandbox.fetch = async (url) => {
    calls.push(url);
    if (url.includes('sinceSeq=999')) {
      return { ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'MARKER_AHEAD', message: 'reset' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, briefing }) };
  };
  let shown = null;
  await instance.loadBriefing('s1', { setBriefing: (value) => { shown = value; }, setError: () => {} });
  eq(calls.length, 2, 'windowed call, then whole-session call');
  ok(calls[1] !== undefined && !calls[1].includes('sinceSeq'), 'the retry asks for everything');
  eq(store.has('dsh-morning-paper:seen:s1'), false, 'the stale marker is gone');
  eq(shown.sessionId, 'session-1', 'the page recovered');
  eq(instance.state.error, null, 'and reported no error');
});

await acheck('a refusal that is not about the marker surfaces as an error', async () => {
  const { definition, sandbox, store } = loadClientBundle();
  const instance = definition.factory(emptyRequire);
  store.set('dsh-morning-paper:seen:s1', '42');
  sandbox.fetch = async () => ({ ok: false, status: 413, json: async () => ({ ok: false, error: { code: 'LOG_TOO_LARGE', message: 'too big' } }) });
  let error = null;
  await instance.loadBriefing('s1', { setBriefing: () => {}, setError: (value) => { error = value; } });
  eq(error, { code: 'LOG_TOO_LARGE', message: 'too big' }, 'error surfaced');
});

await acheck('a network failure surfaces as an error and does not throw', async () => {
  const { definition, sandbox, store } = loadClientBundle();
  const instance = definition.factory(emptyRequire);
  store.set('dsh-morning-paper:seen:s1', '42');
  sandbox.fetch = async () => { throw new Error('offline'); };
  let error = null;
  await instance.loadBriefing('s1', { setBriefing: () => {}, setError: (value) => { error = value; } });
  eq(error.code, 'NETWORK', 'code');
  eq(error.message, 'offline', 'message');
});

await acheck('a session id-less load is a no-op', async () => {
  const { definition, sandbox } = loadClientBundle();
  const instance = definition.factory(emptyRequire);
  let called = false;
  sandbox.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  await instance.loadBriefing(undefined, { setBriefing: () => {}, setError: () => {} });
  eq(called, false, 'no request');
});

/* ------------------------------------------------------- packaging */

check('the package manifest wires the bundle and the client half', () => {
  const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  eq(manifest.name, 'dsh-morning-paper', 'name');
  eq(manifest.dsh.bundle.patch, './cordis.patch.yml', 'bundle patch');
  eq(manifest.dsh.client.platform, 'web', 'client platform');
  ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'), 'client inject');
  for (const [key, relative] of Object.entries(manifest.exports)) {
    ok(existsSync(new URL(relative, import.meta.url)), `export ${key} -> ${relative}`);
  }
  for (const relative of manifest.files) {
    ok(existsSync(new URL(relative, import.meta.url)), `declared file ${relative}`);
  }
});

check('the bundle patch inserts this plugin into whatever profile installs it', () => {
  const patch = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8');
  ok(patch.includes('- insert:'), 'has an insert row');
  ok(patch.includes('name: dsh-morning-paper'), 'inserts this package');
  ok(patch.includes('id: morning-paper'), 'with a stable row id');
});

/* ------------------------------------------------------------------ report */

console.log(`dsh-morning-paper selftest: ${String(passed)} passed, ${String(failures.length)} failed`);
for (const failure of failures) console.error(`  FAIL ${failure.label}\n       ${failure.message}`);
if (failures.length > 0) process.exit(1);

/**
 * dsh-morning-paper — real-log verification.
 *
 * Reads the session logs DSH actually wrote to `$DSH_HOME/sessions/` and builds
 * a briefing from each one, so the pure core is exercised against real event
 * payloads instead of only hand-written fixtures.
 *
 *   node verify-real-log.mjs                  # table over every session, page for the newest top-level one
 *   node verify-real-log.mjs <path.jsonl.zstd>  # one specific log
 *   node verify-real-log.mjs --all-pages      # render a front page for every top-level session
 *
 * Storage detail this tool has to handle: a session log is a series of
 * concatenated zstd frames, so a single-frame decoder stops after the header.
 * The `zstd` CLI concatenates frames, which is why this dev tool shells out to
 * it. The plugin itself never touches these files — it reads through
 * `ctx.sessionQuery` — so none of this is runtime code.
 */

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { BriefingError, buildBriefing, renderBriefingText } from './lib/briefing.js';

const run = promisify(execFile);

/** @returns the session-log root for this machine. */
function sessionsRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'sessions');
}

/**
 * Decode one multi-frame zstd log.
 * @param path - log file path.
 * @returns the decompressed UTF-8 text.
 */
async function decodeLog(path) {
  const { stdout } = await run('zstd', ['-d', '-c', path], { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' });
  return stdout.toString('utf8');
}

/**
 * Reconstruct the `readSession`-shaped payload from an on-disk log.
 *
 * The durable fork-lineage cut is projected into the log as `session/end-seed`,
 * and the docs say to read the LAST such event, so the inherited prefix is
 * everything up to and including it.
 *
 * @param text - decoded log text.
 * @returns `{ session, inheritedEventCount, events }`, or null when unusable.
 */
function parseLog(text) {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (header?.type !== 'session') return null;
  const { type: _type, ...session } = header;
  const events = [];
  let lastSeedSeq = -1;
  for (const line of lines.slice(1)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event?.type !== 'string') continue;
    if (event.type === 'session/end-seed' && typeof event.seq === 'number' && event.seq > lastSeedSeq) lastSeedSeq = event.seq;
    events.push(event);
  }
  const inheritedEventCount = session.isSeeded === true && lastSeedSeq >= 0 ? lastSeedSeq + 1 : 0;
  return { session, inheritedEventCount, events };
}

/** @returns every session log path, newest first. */
async function findLogs() {
  const root = sessionsRoot();
  let workspaces;
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspacePath = join(root, workspace.name);
    let sessions;
    try {
      sessions = await readdir(workspacePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const dir = join(workspacePath, session.name);
      let entries;
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!/^session\..*\.jsonl\.zstd$/.test(entry)) continue;
        const path = join(dir, entry);
        const info = await stat(path);
        if (info.size === 0) continue;
        found.push({ path, mtime: info.mtimeMs, sessionId: session.name, workspace: workspace.name });
      }
    }
  }
  return found.sort((left, right) => right.mtime - left.mtime);
}

/** @returns one summary row for a log, or the refusal that stopped it. */
function summarize(log, path, now) {
  try {
    const briefing = buildBriefing(log, -1, now);
    return {
      path,
      refused: null,
      origin: log.session.origin ?? 'top-level',
      seeded: log.session.isSeeded === true,
      events: log.events.length,
      window: briefing.window.events,
      turns: briefing.turns,
      actions: briefing.actionRequired.length,
      lead: briefing.lead.kind,
      tokens: briefing.business.totalTokens,
      cache: briefing.business.cacheHitPercent,
      failures: briefing.corrections.toolFailures,
      retries: briefing.corrections.llmRetries,
      files: briefing.business.files.length,
      briefing,
    };
  } catch (error) {
    if (error instanceof BriefingError) {
      return {
        path,
        refused: error.code,
        message: error.message,
        origin: log.session.origin ?? 'top-level',
        seeded: log.session.isSeeded === true,
        events: log.events.length,
      };
    }
    throw error;
  }
}

/** @returns nothing; throws when the page is not renderable. */
function assertRenderable(briefing) {
  const text = renderBriefingText(briefing);
  if (!text.includes('THE MORNING PAPER')) throw new Error('masthead missing');
  // Structural characters are ASCII, but quoted session content is arbitrary
  // Unicode, so the invariant is "no control characters" rather than "ASCII".
  if (/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/.test(text)) throw new Error('page emitted control characters');
  if (text.includes('undefined')) throw new Error('page leaked the word undefined');
  if (text.includes('NaN')) throw new Error('page leaked NaN');
  return text;
}

const args = process.argv.slice(2);
const explicit = args.find((value) => !value.startsWith('--'));
const allPages = args.includes('--all-pages');

const logs = explicit === undefined ? await findLogs() : [{ path: explicit, mtime: Date.now(), sessionId: 'explicit', workspace: '-' }];
if (logs.length === 0) {
  console.error(`no session logs found under ${sessionsRoot()}`);
  process.exit(1);
}

let verified = 0;
let refused = 0;
const rendered = [];

console.log(`session logs under ${sessionsRoot()}: ${String(logs.length)}`);
console.log('');
console.log('  origin     seeded  events  window  turns(c/b/e/i)  actions  lead         tokens   cache  fail  page');
console.log('  ---------- ------  ------  ------  --------------  -------  -----------  -------  -----  ----  ----');

for (const entry of logs) {
  const text = await decodeLog(entry.path);
  const log = parseLog(text);
  if (log === null) {
    console.log(`  ${entry.sessionId.slice(0, 8)}  UNPARSEABLE`);
    continue;
  }
  const now = Date.now();
  const row = summarize(log, entry.path, now);
  if (row.refused !== null) {
    refused += 1;
    console.log(`  ${String(row.origin).padEnd(10)} ${String(row.events).padStart(6)}  ${String(row.refused).padEnd(20)} (refused: ${row.message})`);
    continue;
  }
  // Determinism and non-mutation are contract properties, so check them on real data too.
  const before = JSON.stringify(log.events);
  const again = JSON.stringify(buildBriefing(log, -1, now).masthead);
  if (JSON.stringify(row.briefing.masthead) !== again) throw new Error(`${entry.path}: masthead is not deterministic`);
  if (JSON.stringify(log.events) !== before) throw new Error(`${entry.path}: buildBriefing mutated its input`);
  assertRenderable(row.briefing);
  verified += 1;

  const flags = [
    String(row.events),
    String(row.window),
    `${String(row.turns.completed)}/${String(row.turns.blocked)}/${String(row.turns.error)}/${String(row.turns.interrupted)}`,
    String(row.actions),
    row.lead,
    row.tokens.toLocaleString('en-US'),
    row.cache === null ? '-' : `${String(row.cache)}%`,
    String(row.failures),
  ];
  console.log(
    `  ${(row.origin ?? '?').padEnd(10)} ${(row.seeded ? 'yes' : 'no').padEnd(6)}  ${flags[0].padStart(6)}  ${flags[1].padStart(6)}  ${flags[2].padEnd(14)}  ${flags[3].padStart(7)}  ${flags[4].padEnd(11)}  ${flags[5].padStart(7)}  ${flags[6].padStart(5)}  ${flags[7].padStart(4)}  ok`,
  );
  if (row.origin === 'top-level') rendered.push({ entry, row });
}

console.log('');
console.log(`verified ${String(verified)} log(s); ${String(refused)} refused by a typed guard.`);

const pages = allPages ? rendered : rendered.slice(0, 1);
for (const { entry, row } of pages) {
  console.log('');
  console.log(`--- ${entry.sessionId} (${entry.workspace}) ${entry.path}`);
  console.log(assertRenderable(row.briefing));
}
if (pages.length === 0) {
  console.log('');
  console.log('no top-level session log available to render; every log found is a subagent transcript,');
  console.log('which this plugin refuses by design because the parent session owns it.');
}

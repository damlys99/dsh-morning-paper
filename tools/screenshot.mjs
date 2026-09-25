/**
 * dsh-morning-paper — screenshot generator.
 *
 * Renders the paper's three pages with the SHIPPED stylesheet and the SHIPPED
 * render tree, then photographs them with headless chromium.
 *
 *   node tools/screenshot.mjs
 *
 * Why this exists instead of hand-taken PNGs: the README's images cannot drift
 * from the code. `PAPER_CSS` and `paperTree` are imported from `lib/client.js`
 * exactly as they ship, and the data comes from `buildBriefing` in
 * `lib/briefing.js`, so a stylesheet or layout change is one command away from
 * fresh screenshots. Run it after any visual change.
 *
 * Repo tool, not runtime code: it needs a chromium binary and ImageMagick, and
 * is deliberately excluded from the published package (`files` in package.json).
 *
 * Environment:
 *   CHROME_PATH   path to a chromium/chrome binary (otherwise auto-detected in
 *                 ~/.cache/ms-playwright)
 *
 * The fixture is synthetic on purpose. A real session log would put the author's
 * paths, failures and private prompts into a public README.
 *
 * Capture goes through chromium's own `--screenshot` flag rather than a driver
 * library: this machine's Playwright/CDP capture path dies with "unable to
 * capture screenshot", while the CLI path is one process and no dependency.
 */

process.env.TZ = 'UTC';

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const OUT_DIR = new URL('../assets/', import.meta.url);
const WORK_DIR = new URL('../.screenshot-work/', import.meta.url);
const { buildBriefing } = await import('../lib/briefing.js');

/** Canvas width in CSS pixels; the paper caps itself at 1000px plus margins. */
const WIDTH = 1120;
/** Tall enough for the longest page; the empty remainder is trimmed away. */
const CANVAS_HEIGHT = 2600;
/** The surface the paper sits on, used as both canvas and frame colour. */
const CANVAS = '#ececed';

/* ------------------------------------------------------------------ capture */

/** @returns a chromium executable path. */
function findChrome() {
  if (typeof process.env.CHROME_PATH === 'string' && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const root = join(homedir(), '.cache/ms-playwright');
  if (existsSync(root)) {
    for (const entry of readdirSync(root).filter((name) => name.startsWith('chromium-')).sort().reverse()) {
      for (const relative of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const candidate = join(root, entry, relative);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error('no chromium binary found. Set CHROME_PATH.');
}

/**
 * Photograph one HTML file, then crop the unused canvas and downscale.
 *
 * `-fuzz 2%` is deliberately small: the cream sheet differs from the grey canvas
 * by only about 4%, so a larger fuzz would trim the paper itself away. The soft
 * shadow survives the crop, which is what makes the sheet read as a sheet. The
 * palette is then quantised, which a two-tone page tolerates without visible
 * banding and which keeps the committed images small.
 *
 * @param chrome - chromium executable.
 * @param htmlPath - the page to shoot.
 * @param pngPath - where the PNG goes.
 * @returns the PNG's byte size.
 */
function capture(chrome, htmlPath, pngPath) {
  execFileSync(chrome, [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--window-size=${String(WIDTH)},${String(CANVAS_HEIGHT)}`,
    '--virtual-time-budget=3000',
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync('magick', [
    pngPath,
    '-fuzz', '2%', '-trim', '+repage',
    '-bordercolor', CANVAS, '-border', '22',
    '-strip', '-resize', '60%',
    // A two-tone page, so a 128-colour palette is visually identical here and
    // shrinks the file about threefold (240 kB -> 75 kB).
    '-colors', '128', '-define', 'png:compression-level=9',
    pngPath,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  return statSync(pngPath).size;
}

/* ------------------------------------------------------------------- client */

/** Evaluate the real client bundle and return its exports. */
function loadClient() {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let definition = null;
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    window: {
      __ModuleLoader__: { load: (value) => { definition = value; } },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    },
    document: { head: { appendChild: () => {} }, getElementById: () => null, createElement: () => ({}) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return definition.factory(() => { throw new Error('no module in the screenshot sandbox'); });
}

/* ------------------------------------------------------------------ fixture */

/**
 * A synthetic but realistic session: nine turns, file churn, a failed edit that
 * was retried, a failed read that was not, shell commands, a deliverable, a few
 * asks, and one approval still waiting.
 *
 * @returns a `readSession`-shaped log.
 */
function fixture() {
  const MINUTE = 60_000;
  const created = Date.UTC(2026, 2, 14, 13, 20, 0);
  let time = created;
  let seq = 0;
  const events = [];
  const at = (ms) => { time += ms; };
  const push = (type, data) => {
    seq += 1;
    events.push({ type, seq, time, data });
  };
  const usage = (input, cacheRead, output) => ({ inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: output });
  const toolCall = (turn, callId, name, args) => push('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) });
  const toolOk = (turn, callId) => push('tool/result', { turn, step: 1, message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: false }] } });
  const toolFail = (turn, callId, code) => push('tool/result', { turn, step: 1, message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: true }] }, error: { name: 'FsError', code } });

  push('session/title', { title: 'refactor auth', messageSeqs: [], source: 'provider' });

  // turn 1 — read the code
  push('user/message', { content: [{ type: 'text', text: 'the session token handling is a mess, split it out' }] });
  push('turn/start', { turn: 1 });
  at(2 * MINUTE);
  push('step/start', { turn: 1, step: 1 });
  toolCall(1, 'c1', 'read', { file_path: 'src/auth/session.ts' });
  at(400);
  toolOk(1, 'c1');
  toolCall(1, 'c2', 'grep', { pattern: 'sessionToken' });
  at(900);
  toolOk(1, 'c2');
  push('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Found three call sites.' }] }, stream: [], usage: usage(1200, 48_000, 320) });
  at(1 * MINUTE);
  push('turn/end', { turn: 1, reason: { kind: 'completed' } });

  // turn 2 — first write, hits a stale-version guard, retried
  push('user/message', { content: [{ type: 'text', text: 'go ahead, keep it backward compatible' }] });
  push('turn/start', { turn: 2 });
  at(30_000);
  push('step/start', { turn: 2, step: 1 });
  toolCall(2, 'c3', 'edit', { file_path: 'src/auth/session.ts' });
  at(300);
  toolFail(2, 'c3', 'FS_STALE_VERSION');
  toolCall(2, 'c4', 'read', { file_path: 'src/auth/session.ts' });
  at(200);
  toolOk(2, 'c4');
  toolCall(2, 'c5', 'edit', { file_path: 'src/auth/session.ts' });
  at(350);
  toolOk(2, 'c5');
  push('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'Rebased the edit onto the current file.' }] }, stream: [], usage: usage(2_400, 180_000, 640) });
  at(40_000);
  push('turn/end', { turn: 2, reason: { kind: 'completed' } });

  // turn 3 — extract the module
  push('turn/start', { turn: 3 });
  at(20_000);
  push('step/start', { turn: 3, step: 1 });
  toolCall(3, 'c6', 'write', { file_path: 'src/auth/token.ts' });
  at(500);
  toolOk(3, 'c6');
  toolCall(3, 'c7', 'edit', { file_path: 'src/auth/session.ts' });
  at(300);
  toolOk(3, 'c7');
  toolCall(3, 'c8', 'edit', { file_path: 'src/auth/index.ts' });
  at(260);
  toolOk(3, 'c8');
  push('assistant/message', { turn: 3, step: 1, message: { content: [{ type: 'text', text: 'token.ts extracted.' }] }, stream: [], usage: usage(1_800, 240_000, 520) });
  at(30_000);
  push('turn/end', { turn: 3, reason: { kind: 'completed' } });

  // turn 4 — the expensive one
  push('turn/start', { turn: 4 });
  at(9 * MINUTE);
  push('step/start', { turn: 4, step: 1 });
  for (let index = 0; index < 9; index += 1) {
    const id = `r${String(index)}`;
    toolCall(4, id, 'read', { file_path: `src/auth/call-site-${String(index)}.ts` });
    at(240);
    toolOk(4, id);
  }
  toolCall(4, 'b1', 'bash', { command: 'pnpm test --filter auth' });
  at(96_000);
  toolFail(4, 'b1', 'EXIT_1');
  toolCall(4, 'b2', 'bash', { command: 'pnpm test --filter auth -- --reporter=verbose' });
  at(140_000);
  toolOk(4, 'b2');
  push('assistant/message', { turn: 4, step: 1, message: { content: [{ type: 'text', text: 'Nine call sites updated, suite green.' }] }, stream: [], usage: usage(9_400, 3_100_000, 12_600) });
  at(4 * MINUTE);
  push('turn/end', { turn: 4, reason: { kind: 'completed' } });

  // turn 5 — docs
  push('turn/start', { turn: 5 });
  at(40_000);
  push('step/start', { turn: 5, step: 1 });
  toolCall(5, 'c9', 'write', { file_path: 'docs/refactor-plan.md' });
  at(400);
  toolOk(5, 'c9');
  toolCall(5, 'c10', 'edit', { file_path: 'src/auth/__tests__/session.test.ts' });
  at(300);
  toolOk(5, 'c10');
  push('deliverables/presented', { turn: 5, callId: 'p1', files: [{ path: 'docs/refactor-plan.md', description: 'the migration plan' }] });
  push('assistant/message', { turn: 5, step: 1, message: { content: [{ type: 'text', text: 'Plan written.' }] }, stream: [], usage: usage(1_100, 420_000, 380) });
  at(50_000);
  push('turn/end', { turn: 5, reason: { kind: 'completed' } });

  // turn 6 — a failure nobody came back to
  push('turn/start', { turn: 6 });
  at(40_000);
  push('step/start', { turn: 6, step: 1 });
  toolCall(6, 'c11', 'read', { file_path: 'src/legacy/old-auth.ts' });
  at(200);
  toolFail(6, 'c11', 'FS_NOT_OBSERVED');
  toolCall(6, 'c12', 'edit', { file_path: 'src/auth/token.ts' });
  at(300);
  toolOk(6, 'c12');
  push('assistant/message', { turn: 6, step: 1, message: { content: [{ type: 'text', text: 'Left the legacy file alone.' }] }, stream: [], usage: usage(900, 300_000, 260) });
  at(20_000);
  push('turn/end', { turn: 6, reason: { kind: 'completed' } });

  // turn 7 — a model retry
  push('turn/start', { turn: 7 });
  at(60_000);
  push('llm/retry-started', {});
  push('step/start', { turn: 7, step: 1 });
  toolCall(7, 'b3', 'bash', { command: 'git diff --stat' });
  at(120);
  toolOk(7, 'b3');
  push('assistant/message', { turn: 7, step: 1, message: { content: [{ type: 'text', text: 'Diff is small.' }] }, stream: [], usage: usage(1_400, 510_000, 300) });
  at(30_000);
  push('turn/end', { turn: 7, reason: { kind: 'completed' } });

  // turn 8 — a compaction
  push('turn/start', { turn: 8 });
  at(90_000);
  push('compaction/start', {});
  push('step/start', { turn: 8, step: 1 });
  toolCall(8, 'b4', 'bash', { command: 'pnpm test' });
  at(70_000);
  toolOk(8, 'b4');
  push('assistant/message', { turn: 8, step: 1, message: { content: [{ type: 'text', text: 'All green.' }] }, stream: [], usage: usage(2_100, 640_000, 3_400) });
  at(60_000);
  push('turn/end', { turn: 8, reason: { kind: 'completed' } });

  // turn 9 — blocked on you
  push('turn/start', { turn: 9 });
  at(20_000);
  push('step/start', { turn: 9, step: 1 });
  toolCall(9, 'b5', 'bash', { command: 'rm -rf node_modules && pnpm install' });
  at(2_000);
  push('approval/asked', { id: 'a1', toolName: 'bash', callId: 'b5', reason: 'rm -rf node_modules && pnpm install' });
  push('assistant/message', { turn: 9, step: 1, message: { content: [{ type: 'text', text: 'I need permission to reinstall dependencies.' }] }, stream: [], usage: usage(1_600, 690_000, 410) });
  at(40_000);
  push('turn/end', { turn: 9, reason: { kind: 'blocked' } });

  return {
    session: { id: 'fixture-session', version: 3, createdAt: created, cwd: '/home/dev/project' },
    inheritedEventCount: 0,
    title: 'refactor auth',
    events,
  };
}

/* ------------------------------------------------------------------ render */

/** The element shape `paperTree` builds, turned into real HTML. */
function element(type, props, children) {
  const list = children === undefined ? [] : (Array.isArray(children) ? children : [children]);
  return { type, props: props ?? {}, children: list };
}

/** @returns CSS text for one style object. */
function styleText(style) {
  return Object.entries(style)
    .map(([property, value]) => `${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${String(value)}`)
    .join(';');
}

/** @returns HTML for one node from `paperTree`. */
function toHtml(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (Array.isArray(node)) return node.map(toHtml).join('');
  const attributes = [];
  if (node.props.className !== undefined) attributes.push(`class="${String(node.props.className)}"`);
  if (node.props.style !== undefined) attributes.push(`style="${styleText(node.props.style)}"`);
  if (node.props.title !== undefined) attributes.push(`title="${String(node.props.title)}"`);
  if (node.props.disabled === true) attributes.push('disabled');
  const open = attributes.length > 0 ? `<${node.type} ${attributes.join(' ')}>` : `<${node.type}>`;
  return `${open}${node.children.map(toHtml).join('')}</${node.type}>`;
}

/* -------------------------------------------------------------------- main */

const client = loadClient();
const log = fixture();
// `now` is fixed so the dateline and the away duration are reproducible.
const now = log.events[log.events.length - 1].time + 42 * 60_000;
const briefing = buildBriefing(log, -1, now, {
  // The DeepSeek routes declare their own capacity (DEFAULT_CONTEXT_WINDOW is
  // 1e6), so this is the ordinary case: a model-declared ceiling, no caveat.
  weather: { contextTokens: 340_115, surfaceTokens: 305_100, contextWindow: 1_000_000, source: 'model', percent: 34 },
});
const display = client.summarize(briefing, null);
const pages = client.pageList(display);

const chrome = findChrome();
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });

const written = [];
try {
  for (const [index, page] of pages.entries()) {
    const number = index + 1;
    const tree = client.paperTree(element, display, {
      page: number,
      markedReadAt: null,
      onPage: () => {},
      onMarkRead: () => {},
      onRefresh: () => {},
      onForget: () => {},
    });
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${page.label}</title><style>
  html, body { margin: 0; padding: 28px 24px; background: ${CANVAS}; }
  ${client.PAPER_CSS}
</style></head><body>${toHtml(tree)}</body></html>`;

    const name = `${String(number)}-${page.id}.png`;
    const htmlPath = new URL(`page-${String(number)}.html`, WORK_DIR).pathname;
    const pngPath = new URL(name, OUT_DIR).pathname;
    writeFileSync(htmlPath, html);
    const bytes = capture(chrome, htmlPath, pngPath);
    written.push({ name, label: page.label, bytes });
    console.log(`  assets/${name}  ${String(Math.round(bytes / 1024))} kB  (page ${String(number)} · ${page.label})`);
  }
} finally {
  rmSync(WORK_DIR, { recursive: true, force: true });
}

writeFileSync(
  new URL('../screenshots.json', import.meta.url),
  `${JSON.stringify(written.map((file) => `assets/${file.name}`), null, 2)}\n`,
);
console.log(`wrote screenshots.json with ${String(written.length)} entries`);

/**
 * dsh-morning-paper — host half.
 *
 * Two registrations, both effect-scoped:
 *
 * - One same-origin GET route that reads a session log through `ctx.sessionQuery`
 *   and answers a computed front page. Reading is the whole job: nothing here
 *   mutates a session, appends an event, or sends anything to a model. The
 *   briefing is derived state, so it can never pollute the context it exists to
 *   help you manage.
 * - One `/briefing` slash command for the same document in plain text, for
 *   people who would rather read it in the transcript than in the panel.
 *
 * A best-effort live watermark of pending user questions is kept in memory, and
 * deliberately NOT in durable storage: user-questions has no durable session
 * event, so a persisted entry could outlive its question and nag forever. The
 * watermark is set when the waterfall opens and cleared when it settles, so it
 * cannot outlive the request it describes.
 */

import {
  BriefingError,
  COMMAND_NAME,
  ROUTE_PATH,
  buildBriefing,
  decodeBriefingRequest,
  effectiveRoute,
  renderBriefingText,
} from './briefing.js';

export { COMMAND_NAME, ROUTE_PATH };

/** Cordis plugin name. */
export const name = 'morning-paper';

/** Host capabilities required for the route. */
export const inject = ['sessionQuery', 'webServer'];

/**
 * Write one JSON response.
 * @param response - HTTP response owned by this handler.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
function respondJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

/**
 * Write one plain-text response.
 * @param response - HTTP response owned by this handler.
 * @param status - HTTP status.
 * @param text - body text.
 */
function respondText(response, status, text) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(text);
}

/**
 * Ask the live session, when there is one, how much context is in play. Every
 * step is optional: a cold session, a missing meter, or a model with no declared
 * window all degrade to `null` rather than to a guess.
 *
 * @param ctx - plugin context carrying optional live services.
 * @param sessionId - session to measure.
 * @returns the weather section, or null.
 */
/**
 * Accept a configured context ceiling, or nothing.
 *
 * There is no default. Inventing a capacity for a model that never declared one
 * would turn a guess into a percentage, which is the one thing this page must
 * not do; a missing ceiling stays missing and says so.
 *
 * @param value - the plugin row's `contextWindow` config value.
 * @returns a positive safe integer, or null.
 */
export function normalizeContextWindow(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * @param ctx - plugin context carrying optional live services.
 * @param sessionId - session to measure.
 * @param configuredWindow - a ceiling from plugin config, used only when the
 * model's own adapter declares none.
 * @param route - the effective `{ provider, model }`, when the caller knows it.
 * @returns the weather section, or null.
 */
export async function resolveWeather(ctx, sessionId, configuredWindow = null, route = null) {
  try {
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined;
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
    const session = agent?.session;
    const meter = typeof ctx?.get === 'function' ? ctx.get('tokenMeter') : undefined;
    if (session === undefined || session === null || typeof meter?.measure !== 'function') return null;
    const measurement = meter.measure(session);
    const contextTokens = typeof measurement?.totalTokens === 'number' ? measurement.totalTokens : null;
    if (contextTokens === null) return null;

    let contextWindow = null;
    let source = null;
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
    // The route that ran, not the route the agent was constructed with: a session
    // using the default model never sets `agent.options.provider`.
    const provider = route?.provider ?? agent?.options?.provider;
    const model = route?.model ?? agent?.options?.model;
    // `resolveModelInfo` is the runtime method that normalizes adapter metadata and
    // is what automatic compaction reads its capacity from. `resolveModel` is the
    // adapter's own face (and, on this runtime, not even present on the service),
    // so calling it silently yielded no capacity at all.
    const resolve = typeof llm?.resolveModelInfo === 'function'
      ? llm.resolveModelInfo
      : (typeof llm?.resolveModel === 'function' ? llm.resolveModel : null);
    if (resolve !== null && typeof provider === 'string' && typeof model === 'string') {
      const info = await resolve.call(llm, provider, model);
      const window = info?.context?.contextWindow;
      if (typeof window === 'number' && window > 0) {
        contextWindow = window;
        source = 'model';
      }
    }
    // A model-declared capacity always wins; a configured one is an assumption
    // and is labelled as such wherever it is shown.
    if (contextWindow === null && configuredWindow !== null) {
      contextWindow = configuredWindow;
      source = 'config';
    }
    return {
      contextTokens,
      surfaceTokens: typeof measurement.surfaceTokens === 'number' ? measurement.surfaceTokens : null,
      contextWindow,
      source,
      percent: contextWindow === null
        ? null
        : Math.round((contextTokens / contextWindow) * 1000) / 10,
    };
  } catch {
    return null;
  }
}

/**
 * Build the in-memory pending-question watermark.
 *
 * The listener is a waterfall member, so delegating with `next()` is
 * mandatory. Recording is best-effort and cannot change the outcome: a
 * recording failure still delegates, and the clearing hook is attached to the
 * returned promise without altering what it resolves or rejects with.
 *
 * @returns the live pending map and the listener to register.
 */
export function createQuestionWatcher() {
  const pending = new Map();
  let counter = 0;

  /**
   * @param request - the user-questions request payload.
   * @param next - downstream waterfall step; always called exactly once.
   * @returns whatever the downstream chain returns.
   */
  function listener(request, next) {
    let key = null;
    try {
      counter += 1;
      key = `pending-${String(counter)}`;
      const items = Array.isArray(request?.questions) ? request.questions : [];
      const first = items.find((item) => item !== null && typeof item === 'object' && typeof item.question === 'string');
      pending.set(key, {
        id: key,
        question: first === undefined ? 'a question is waiting for you' : first.question,
        time: Date.now(),
      });
    } catch {
      if (key !== null) pending.delete(key);
      key = null;
    }
    const downstream = next();
    if (key === null) return downstream;
    return Promise.resolve(downstream).finally(() => {
      pending.delete(key);
    });
  }

  return { pending, listener };
}

/** @returns the pending questions as a newest-first list for one briefing. */
function pendingQuestionList(questions) {
  const items = [...questions.pending.values()];
  return items.sort((left, right) => right.time - left.time);
}

/**
 * Read one session's log and fold it into a briefing.
 *
 * @param ctx - plugin context carrying `sessionQuery`.
 * @param sessionId - session to brief.
 * @param sinceSeq - last seq the caller saw, or -1 for the whole session.
 * @param pendingQuestions - live watermark entries.
 * @returns the briefing document.
 */
export async function readBriefing(ctx, sessionId, sinceSeq, pendingQuestions = [], configuredWindow = null) {
  const log = await ctx.sessionQuery.readSession(sessionId);
  let title;
  try {
    const snapshot = typeof ctx.sessionQuery.readTitle === 'function'
      ? await ctx.sessionQuery.readTitle(sessionId)
      : undefined;
    if (typeof snapshot?.title === 'string' && snapshot.title.length > 0) title = snapshot.title;
  } catch {
    title = undefined;
  }
  const weather = await resolveWeather(ctx, sessionId, configuredWindow, effectiveRoute(log));
  return buildBriefing(
    title === undefined ? log : { ...log, title },
    sinceSeq,
    Date.now(),
    { pendingQuestions, weather },
  );
}

/**
 * Read just the current log tail, so a browser that has never seen this session
 * can establish its reading marker without reading a single event.
 *
 * @param ctx - plugin context carrying `sessionQuery`.
 * @param sessionId - session to probe.
 * @returns the newest seq, or -1 for an empty log.
 */
export async function readTailSeq(ctx, sessionId) {
  const records = await ctx.sessionQuery.listEvents(sessionId);
  let tail = -1;
  if (Array.isArray(records)) {
    for (const record of records) {
      if (typeof record?.seq === 'number' && record.seq > tail) tail = record.seq;
    }
  }
  return tail;
}

/**
 * Answer one briefing request. Every guard runs before any read, so a refused
 * request costs nothing and changes nothing.
 *
 * @param ctx - plugin context.
 * @param request - incoming HTTP request.
 * @param response - HTTP response owned by this handler.
 * @param questions - live pending-question watermark.
 */
export async function handleRoute(ctx, request, response, questions, configuredWindow = null) {
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET' });
    response.end();
    return;
  }
  let format = 'json';
  try {
    const url = new URL(typeof request.url === 'string' ? request.url : '/', 'http://localhost');
    const decoded = decodeBriefingRequest(url.searchParams);
    format = decoded.format;
    if (decoded.probe) {
      const tailSeq = await readTailSeq(ctx, decoded.sessionId);
      respondJson(response, 200, { ok: true, sessionId: decoded.sessionId, tailSeq });
      return;
    }
    const briefing = await readBriefing(
      ctx,
      decoded.sessionId,
      decoded.sinceSeq,
      pendingQuestionList(questions),
      configuredWindow,
    );
    if (format === 'text') respondText(response, 200, renderBriefingText(briefing));
    else respondJson(response, 200, { ok: true, briefing });
  } catch (error) {
    if (error instanceof BriefingError) {
      if (format === 'text') respondText(response, error.status, `${error.code}: ${error.message}`);
      else respondJson(response, error.status, { ok: false, error: { code: error.code, message: error.message } });
      return;
    }
    const message = error instanceof Error ? error.message : 'briefing failed';
    if (format === 'text') respondText(response, 502, `BRIEFING_FAILED: ${message}`);
    else respondJson(response, 502, { ok: false, error: { code: 'BRIEFING_FAILED', message } });
  }
}

/**
 * Run the `/briefing` command: the same document, rendered as text into the
 * transcript. This is the only path that is allowed to touch the conversation,
 * and it is always user-invoked.
 *
 * @param ctx - plugin context.
 * @param invocation - command invocation carrying the receiving agent.
 * @param questions - live pending-question watermark.
 * @returns a command result.
 */
export async function runBriefingCommand(ctx, invocation, questions, configuredWindow = null) {
  try {
    const sessionId = invocation?.agent?.session?.id ?? invocation?.agent?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { kind: 'error', text: 'briefing: this command ran without a session.' };
    }
    const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : '';
    const explicit = /--since\s+(\d+)\b/.exec(raw);
    if (explicit === null && /--since\b/.test(raw)) {
      return { kind: 'error', text: 'briefing: --since takes a non-negative sequence number.' };
    }
    const sinceSeq = explicit === null ? -1 : Number(explicit[1]);
    if (sinceSeq !== -1 && (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0)) {
      return { kind: 'error', text: 'briefing: --since takes a non-negative sequence number.' };
    }
    const briefing = await readBriefing(ctx, sessionId, sinceSeq, pendingQuestionList(questions), configuredWindow);
    return { kind: 'success', text: renderBriefingText(briefing) };
  } catch (error) {
    if (error instanceof BriefingError) return { kind: 'error', text: `briefing: ${error.code} - ${error.message}` };
    return { kind: 'error', text: `briefing: ${error instanceof Error ? error.message : 'failed'}` };
  }
}

/**
 * Register the route, the pending-question watermark, and the command.
 * @param ctx - plugin context.
 */
export function apply(ctx, config) {
  const questions = createQuestionWatcher();
  // Read from the row's `config:` block directly rather than declaring a
  // schemastery schema, so the plugin keeps zero runtime dependencies. One
  // optional integer does not justify a schema, and the value is validated here.
  const configuredWindow = normalizeContextWindow(config?.contextWindow);

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (request, response) => void handleRoute(ctx, request, response, questions, configuredWindow),
    }),
    'morning-paper: briefing route',
  );

  ctx.effect(
    () => ctx.on('user-questions/request', questions.listener),
    'morning-paper: pending-question watermark',
  );

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(
      () => commandCtx.commands.register({
        name: COMMAND_NAME,
        description: 'print the front page for this session: what happened, what broke, what needs you',
        input: { hint: '[--since <seq>]' },
        recordInput: false,
        handler: (invocation) => runBriefingCommand(commandCtx, invocation, questions, configuredWindow),
      }),
      'morning-paper: /briefing command',
    );
  });
}

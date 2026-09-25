/**
 * dsh-morning-paper — browser half.
 *
 * A full Conversation View tab, registered into the official `conversation.view`
 * list slot next to Chat and Trajectory, and rendered as a newspaper front page:
 * masthead, dateline, a boxed bulletin for anything waiting on you, a lede with
 * a drop cap, newspaper columns, and the small print underneath.
 *
 * Nothing here decorates or observes official markup. The tab owns its own
 * surface, and the page is fetched from this plugin's host route.
 *
 * The module owns exactly one piece of state: the seq you last read, in
 * localStorage, so "away" means "since you last looked" without the host having
 * to guess. A first visit shows the whole session rather than nothing, because a
 * page that greets you with silence reads as broken; "Mark read" starts the
 * tracking window from there.
 *
 * A hand-authored module-loader bundle: no build step, one injected stylesheet,
 * no dependency on another feature plugin. The tree builders stay pure so the
 * page's content is testable in Node.
 */

window.__ModuleLoader__.load({
	id: "dsh-morning-paper",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Same-origin route registered by the host half. */
		const ROUTE_PATH = "/morning-paper";
		/** localStorage key prefix for one session's reading marker. */
		const MARKER_PREFIX = "dsh-morning-paper:seen:";
		/** The stylesheet element this bundle owns. */
		const STYLE_ID = "dsh-morning-paper-styles";
		/** How long a settled turn is given to reach the log before a refresh reads it. */
		const SETTLE_DELAY_MS = 1500;
		/**
		 * Poll cadence while the agent is mid-turn, and while it is idle. The poll
		 * itself is cheap — it asks the host for the log tail only — so the full
		 * briefing is re-read only when the tail actually moved.
		 */
		const ACTIVE_POLL_MS = 5000;
		const IDLE_POLL_MS = 20000;

		let React = null;
		try {
			React = require("react");
		} catch {
			React = null;
		}

		/**
		 * The page's palette, in one place.
		 *
		 * A newspaper is cream paper with dark ink in EVERY theme, so these are
		 * fixed values rather than theme tokens. That is deliberate: an earlier
		 * version mixed the sheet from `--dsw-alias-*` variables whose names I had
		 * guessed wrong, which produced light ink on light paper. Pinning both ends
		 * makes legibility a property of the stylesheet instead of a property of
		 * whichever tokens a theme happens to define. `selftest.mjs` asserts the
		 * contrast ratios of every text tier against the sheet.
		 */
		const PAPER_TOKENS = {
			paper: '#f7f2e5',
			ink: '#1b1917',
			inkSoft: '#3d382f',
			inkFaint: '#57503f',
			rule: 'rgba(27, 25, 23, 0.28)',
			edge: 'rgba(27, 25, 23, 0.18)',
			accent: '#8a4a0b',
			bulletin: '#f3e7cf',
		};

		/**
		 * The page's entire look: a serif sheet, small caps, hairline rules, a drop
		 * cap, and newspaper columns. Interpolated from {@link PAPER_TOKENS} so the
		 * palette has exactly one source of truth.
		 */
		const PAPER_CSS = `.dmp-paper {
  --dmp-paper: ${PAPER_TOKENS.paper};
  --dmp-ink: ${PAPER_TOKENS.ink};
  --dmp-ink-soft: ${PAPER_TOKENS.inkSoft};
  --dmp-ink-faint: ${PAPER_TOKENS.inkFaint};
  --dmp-rule: ${PAPER_TOKENS.rule};
  --dmp-accent: ${PAPER_TOKENS.accent};
  --dmp-bulletin-bg: ${PAPER_TOKENS.bulletin};
  --dmp-serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif;
  --dmp-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  box-sizing: border-box;
  max-width: 1000px;
  margin: 0 auto;
  padding: 34px 42px 28px;
  background: var(--dmp-paper);
  background-image: repeating-linear-gradient(0deg, rgba(27, 25, 23, 0.02) 0 1px, transparent 1px 3px);
  color: var(--dmp-ink);
  font-family: var(--dmp-serif);
  font-size: 15.5px;
  line-height: 1.6;
  border: 1px solid ${PAPER_TOKENS.edge};
  border-radius: 2px;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.08), 0 12px 34px rgba(0, 0, 0, 0.22);
}
.dmp-paper * { box-sizing: border-box; }
.dmp-masthead { text-align: center; padding-bottom: 12px; border-bottom: 3px double var(--dmp-rule); margin-bottom: 20px; }
.dmp-name { margin: 0; font-family: var(--dmp-sans); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--dmp-ink-soft); }
.dmp-title { margin: 10px 0 0; font-size: 40px; line-height: 1.04; font-weight: 700; letter-spacing: -0.015em; }
.dmp-dateline { margin-top: 10px; font-family: var(--dmp-sans); font-size: 11px; font-weight: 500; letter-spacing: 0.09em; text-transform: uppercase; color: var(--dmp-ink-faint); }
.dmp-section { margin: 0 0 20px; break-inside: avoid; }
.dmp-section > h2 { margin: 0 0 8px; padding-bottom: 5px; border-bottom: 1px solid var(--dmp-rule); font-family: var(--dmp-sans); font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--dmp-ink-soft); }
.dmp-bulletin { margin: 0 0 22px; padding: 15px 18px 14px; background: var(--dmp-bulletin-bg); border: 1px solid var(--dmp-rule); border-left: 5px solid var(--dmp-accent); }
.dmp-bulletin > h2 { margin: 0 0 9px; padding: 0; border: 0; font-family: var(--dmp-sans); font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--dmp-accent); }
.dmp-bulletin ul { margin: 0; padding: 0; list-style: none; }
.dmp-bulletin li { padding: 6px 0; border-bottom: 1px dotted var(--dmp-rule); }
.dmp-bulletin li:last-child { border-bottom: 0; padding-bottom: 0; }
.dmp-bulletin strong { font-weight: 700; }
.dmp-age { margin-left: 9px; font-family: var(--dmp-sans); font-size: 10.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--dmp-ink-faint); }
.dmp-hint { margin: 10px 0 0; font-size: 13px; font-style: italic; color: var(--dmp-ink-soft); }
.dmp-lede { margin: 0 0 12px; font-size: 21px; line-height: 1.36; font-weight: 600; }
.dmp-lede::first-letter { float: left; padding: 5px 10px 0 0; font-size: 56px; line-height: 0.78; font-weight: 700; }
.dmp-quote { margin: 0; padding: 2px 0 2px 16px; border-left: 3px solid var(--dmp-rule); font-size: 15.5px; font-style: italic; color: var(--dmp-ink-soft); }
.dmp-tools { margin: 11px 0 0; font-family: var(--dmp-sans); font-size: 11.5px; letter-spacing: 0.03em; color: var(--dmp-ink-faint); }
.dmp-columns { column-count: 2; column-gap: 34px; column-rule: 1px solid var(--dmp-rule); }
@media (max-width: 820px) { .dmp-columns { column-count: 1; column-rule: 0; } }
.dmp-columns .dmp-section { margin-bottom: 18px; }
.dmp-figures { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 0; padding: 0; list-style: none; font-family: var(--dmp-sans); font-size: 12px; font-weight: 500; }
.dmp-figures li { white-space: nowrap; }
.dmp-files { margin: 9px 0 0; padding: 9px 0 0; border-top: 1px solid var(--dmp-rule); list-style: none; font-family: var(--dmp-sans); font-size: 11.5px; color: var(--dmp-ink-soft); }
.dmp-files li { padding: 1px 0; overflow-wrap: anywhere; }
.dmp-files li::before { content: "\\2014  "; color: var(--dmp-ink-faint); }
.dmp-empty { margin: 0; font-size: 13.5px; color: var(--dmp-ink-soft); }
.dmp-group { margin: 5px 0 0; font-family: var(--dmp-sans); font-size: 11.5px; color: var(--dmp-ink-soft); }
.dmp-quiet { margin: 8px 0 24px; padding: 34px 12px; text-align: center; font-size: 16px; font-style: italic; color: var(--dmp-ink-soft); }
.dmp-smallprint { margin-top: 22px; padding-top: 12px; border-top: 3px double var(--dmp-rule); font-family: var(--dmp-sans); font-size: 11.5px; line-height: 1.7; color: var(--dmp-ink-soft); }
.dmp-smallprint ul { margin: 0; padding: 0; list-style: none; }
.dmp-smallprint li::before { content: "\\203B  "; color: var(--dmp-ink-faint); }
.dmp-colophon { margin: 10px 0 0; font-style: italic; }
.dmp-error { margin: 0 0 14px; padding: 11px 14px; background: var(--dmp-bulletin-bg); border: 1px solid var(--dmp-rule); border-left: 5px solid var(--dmp-accent); font-family: var(--dmp-sans); font-size: 12.5px; }
.dmp-controls { display: flex; gap: 9px; margin-top: 15px; font-family: var(--dmp-sans); }
.dmp-controls button { padding: 6px 14px; border: 1px solid var(--dmp-rule); border-radius: 2px; background: transparent; color: var(--dmp-ink-soft); font: inherit; font-size: 10.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; cursor: pointer; }
.dmp-controls button:hover:not(:disabled) { background: rgba(27, 25, 23, 0.08); color: var(--dmp-ink); }
.dmp-controls button:disabled { opacity: 0.45; cursor: default; }
.dmp-did { margin: 0 0 16px; font-family: var(--dmp-sans); font-size: 12.5px; line-height: 1.75; color: var(--dmp-ink-soft); }
.dmp-did b { color: var(--dmp-ink); font-weight: 700; }
.dmp-scroll { overflow-x: auto; }
.dmp-table { width: 100%; border-collapse: collapse; font-family: var(--dmp-sans); font-size: 11.5px; }
.dmp-table th { padding: 0 10px 5px 0; border-bottom: 1px solid var(--dmp-rule); text-align: left; font-size: 9.5px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--dmp-ink-faint); white-space: nowrap; }
.dmp-table td { padding: 4px 10px 4px 0; border-bottom: 1px dotted var(--dmp-rule); white-space: nowrap; }
.dmp-table tr:last-child td { border-bottom: 0; }
.dmp-num { text-align: right; font-variant-numeric: tabular-nums; }
.dmp-bad { color: var(--dmp-accent); font-weight: 700; }
.dmp-open { color: var(--dmp-ink-faint); font-style: italic; }
.dmp-bar { display: inline-block; width: 74px; height: 9px; margin-right: 9px; background: rgba(27, 25, 23, 0.1); vertical-align: middle; }
.dmp-bar > i { display: block; height: 100%; background: var(--dmp-ink-soft); }
.dmp-files { margin: 0; padding: 0; list-style: none; font-family: var(--dmp-sans); font-size: 11.5px; }
.dmp-files li { display: flex; gap: 10px; padding: 2px 0; }
.dmp-files .dmp-count { flex: none; min-width: 3.2em; color: var(--dmp-ink-faint); font-variant-numeric: tabular-nums; }
.dmp-files .dmp-path { overflow-wrap: anywhere; color: var(--dmp-ink-soft); }
.dmp-unresolved { margin: 0; padding: 0; list-style: none; font-family: var(--dmp-sans); font-size: 11.5px; }
.dmp-unresolved li { padding: 4px 0; border-bottom: 1px dotted var(--dmp-rule); overflow-wrap: anywhere; }
.dmp-unresolved li:last-child { border-bottom: 0; }
.dmp-unresolved .dmp-when { margin-right: 8px; color: var(--dmp-ink-faint); font-variant-numeric: tabular-nums; }
.dmp-unresolved .dmp-code { color: var(--dmp-accent); font-weight: 700; }
.dmp-unresolved .dmp-cmd { display: block; margin-top: 1px; color: var(--dmp-ink-faint); font-family: var(--dmp-serif); font-style: italic; }
.dmp-asks { margin: 0; padding: 0; list-style: none; font-size: 14px; }
.dmp-asks li { padding: 3px 0 3px 14px; text-indent: -14px; }
.dmp-asks li::before { content: "\\2014  "; color: var(--dmp-ink-faint); }
.dmp-runninghead { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 14px; margin: 0 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--dmp-rule); font-family: var(--dmp-sans); font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--dmp-ink-faint); }
.dmp-runninghead b { color: var(--dmp-ink-soft); font-weight: 700; }
.dmp-pager { display: flex; flex-wrap: wrap; margin: 0 0 20px; padding-bottom: 10px; border-bottom: 3px double var(--dmp-rule); font-family: var(--dmp-sans); }
.dmp-pager button { margin-right: 18px; padding: 2px 0; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--dmp-ink-faint); font: inherit; font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; cursor: pointer; }
.dmp-pager button:hover { color: var(--dmp-ink); border-bottom-color: var(--dmp-rule); }
.dmp-pager button.dmp-page-on { color: var(--dmp-ink); border-bottom-color: var(--dmp-accent); }
.dmp-pagebody { min-height: 8px; }
.dmp-folio { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; font-family: var(--dmp-sans); }
.dmp-nav { display: flex; align-items: center; gap: 12px; font-family: var(--dmp-sans); }
.dmp-folio-page { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--dmp-ink-faint); }
.dmp-notes { margin: 12px 0 0; padding: 0; list-style: none; }
.dmp-nav button { padding: 4px 11px; border: 1px solid var(--dmp-rule); border-radius: 2px; background: transparent; color: var(--dmp-ink-soft); font: inherit; font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; cursor: pointer; }
.dmp-nav button:hover:not(:disabled) { background: rgba(27, 25, 23, 0.08); color: var(--dmp-ink); }
.dmp-nav button:disabled { opacity: 0.4; cursor: default; }
.dmp-controls { margin-top: 0; }
`;

		/** Live view state, mirrored for tests. */
		const state = {
			sessionId: undefined,
			marker: null,
			briefing: null,
			error: null,
			loading: false,
			/** Newest log seq the page reflects; the revision key the poll compares. */
			tailSeq: null,
			/** One poll at a time, so a slow host cannot stack requests. */
			polling: false,
		};

		/** Install the stylesheet once, per document. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (typeof document.getElementById === "function" && document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = PAPER_CSS;
			document.head.appendChild(style);
		}

		/** @returns the localStorage key for one session's reading marker. */
		function markerKey(sessionId) {
			return MARKER_PREFIX + String(sessionId);
		}

		/** @returns the stored marker seq, or null when this browser never read the session. */
		function readMarker(sessionId) {
			try {
				const raw = window.localStorage.getItem(markerKey(sessionId));
				if (raw === null || raw === "") return null;
				const value = Number(raw);
				return Number.isSafeInteger(value) && value >= 0 ? value : null;
			} catch {
				return null;
			}
		}

		/** Persist one reading marker; a storage failure is never fatal. */
		function writeMarker(sessionId, seq) {
			try {
				window.localStorage.setItem(markerKey(sessionId), String(seq));
				state.marker = seq;
			} catch {
				/* private mode or a full quota: the page still works, it just forgets */
			}
		}

		/** Forget the reading marker, so the next load shows the whole session again. */
		function clearMarker(sessionId) {
			try {
				window.localStorage.removeItem(markerKey(sessionId));
			} catch {
				/* see writeMarker */
			}
			state.marker = null;
		}

		/** @returns the message of any thrown value, across realms. */
		function messageOf(error) {
			if (error !== null && typeof error === "object" && typeof error.message === "string") return error.message;
			return String(error);
		}

		/**
		 * Mark everything up to now as read.
		 *
		 * This advances the reading marker and does NOT reload. Blanking the page on
		 * the click was the old behaviour, and it read as "my paper just vanished":
		 * the page you just read stays as the record of it, the confirmation line
		 * says what happened, and the next refresh after new events shows the delta.
		 *
		 * @param sessionId - the visible session.
		 * @param display - the display model, for its window tail.
		 * @param sets - `{ setBriefing, setMarkedReadAt }`.
		 * @returns whether a marker was written.
		 */
		function markAllRead(sessionId, display, sets) {
			if (display === null || display.throughSeq === null || typeof sessionId !== "string") return false;
			writeMarker(sessionId, display.throughSeq);
			sets.setMarkedReadAt(toClock(Date.now()));
			return true;
		}

		/** @returns a compact human duration. */
		function formatDuration(ms) {
			const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
			if (total < 60) return total + "s";
			const minutes = Math.floor(total / 60);
			if (minutes < 60) return minutes + "m";
			const hours = Math.floor(minutes / 60);
			const remMinutes = minutes % 60;
			if (hours < 24) return remMinutes === 0 ? hours + "h" : hours + "h " + remMinutes + "m";
			const days = Math.floor(hours / 24);
			const remHours = hours % 24;
			return remHours === 0 ? days + "d" : days + "d " + remHours + "h";
		}

		/** @returns one sentence describing the lead story. */
		function leadSentence(lead) {
			if (lead === null || typeof lead !== "object") return "Nothing happened while you were out.";
			switch (lead.kind) {
				case "quiet":
					return "Nothing happened while you were out.";
				case "completed":
					return "Turn " + lead.turn + " completed.";
				case "blocked":
					return "Turn " + lead.turn + " ended blocked - the agent is waiting on you.";
				case "error": {
					const code = lead.error === null || lead.error === undefined ? "UNKNOWN" : lead.error.code;
					const message = lead.error === null || lead.error === undefined ? "" : lead.error.message;
					return "Turn " + lead.turn + " failed (" + code + ")" + (message ? ": " + message : "");
				}
				case "interrupted":
					return "Turn " + lead.turn + " was cut off by a restart; the events before the crash are intact.";
				case "max-tokens":
					return "Turn " + lead.turn + " hit the output-token ceiling.";
				case "aborted":
					return "Turn " + lead.turn + " was cancelled" + (lead.cancelReason === null ? "" : " (" + lead.cancelReason + ")") + ".";
				case "activity":
					return "Work was still in progress; no turn has ended in this window.";
				default:
					return "Turn " + lead.turn + " ended (" + lead.kind + ").";
			}
		}

		/** @returns an absolute path with the home directory abbreviated. */
		function shortenPath(path) {
			const home = /^\/(?:home|Users)\/[^/]+\/(.*)$/.exec(path);
			return home === null ? path : "~/" + home[1];
		}

		/** @returns one turn outcome as a word a person would use. */
		function outcomeWord(kind) {
			switch (kind) {
				case null:
				case undefined:
					return "open";
				case "completed":
					return "finished";
				case "error":
					return "failed";
				case "blocked":
					return "blocked";
				case "aborted":
					return "cancelled";
				case "max-tokens":
					return "cut off";
				case "interrupted":
					return "interrupted";
				default:
					return String(kind);
			}
		}

		/** @returns a token count at a scale a person reads without counting digits. */
		function formatTokens(tokens) {
			if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + "M tokens";
			if (tokens >= 1000) return Math.round(tokens / 1000) + "k tokens";
			return tokens + " tokens";
		}

		/** @returns a wall-clock time for one epoch millisecond value. */
		function toClock(ms) {
			const value = Number.isFinite(ms) ? new Date(ms) : null;
			return value === null ? "" : value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		}

		/**
		 * Turn a briefing (or a failure) into the flat display model the tree
		 * builder renders. Pure, so the page's content is testable without React.
		 *
		 * @param briefing - a briefing document, or null while loading.
		 * @param error - a display error, or null.
		 * @returns the display model, or null before the first response.
		 */
		function summarize(briefing, error) {
			if (error !== null && error !== undefined) {
				return {
					kind: "error",
					title: "The Morning Paper",
					dateline: ["unavailable"],
					error: { code: String(error.code ?? "ERROR"), message: String(error.message ?? "") },
					actions: [],
					quiet: false,
					firstLook: false,
					lead: "",
					did: [],
					timeline: [],
					files: [],
					filesTouched: 0,
					delivered: [],
					deliveredMore: 0,
					toolRows: [],
					longest: null,
					toolShare: null,
					money: [],
					figures: [],
					unresolved: [],
					failures: "",
					failureGroups: [],
					asks: [],
					weather: "",
					notes: [],
					throughSeq: null,
				};
			}
			if (briefing === null || typeof briefing !== "object") return null;

			const firstLook = briefing.window?.sinceSeq === -1;
			const actions = (Array.isArray(briefing.actionRequired) ? briefing.actionRequired : []).map((item) => {
				if (item.kind === "approval") {
					return {
						lead: "Approval needed for ",
						strong: String(item.toolName),
						tail: item.reason === null || item.reason === undefined ? "" : ' — "' + item.reason + '"',
						detail: formatDuration(item.ageMs) + " ago",
					};
				}
				if (item.kind === "question") {
					return { lead: "Question waiting: ", strong: String(item.question), tail: "", detail: formatDuration(item.ageMs) + " ago" };
				}
				return { lead: "Turn " + item.turn + " ended ", strong: "blocked", tail: "", detail: formatDuration(item.ageMs) + " ago" };
			});

			const business = briefing.business ?? {};
			const timing = briefing.timing ?? {};
			const turns = briefing.turns ?? {};
			const lead = briefing.lead ?? {};

			const figures = [];
			const tokens = business.totalTokens ?? 0;
			figures.push(formatTokens(tokens));
			if (business.cacheHitPercent !== null && business.cacheHitPercent !== undefined) figures.push("cache hit " + business.cacheHitPercent + "%");
			if (timing.toolShare !== null && timing.toolShare !== undefined) figures.push(timing.toolShare + "% tool time");

			const timeline = (Array.isArray(briefing.timeline) ? briefing.timeline : []).map((row) => ({
				turn: String(row.turn),
				took: formatDuration(row.durationMs),
				steps: String(row.steps),
				tools: String(row.tools),
				tokens: (row.tokens ?? 0).toLocaleString("en-US"),
				outcome: outcomeWord(row.outcome),
				bad: row.outcome === "error" || row.outcome === "blocked",
				open: row.outcome === null || row.outcome === undefined,
			}));

			const files = (Array.isArray(briefing.files?.listed) ? briefing.files.listed : []).map((file) => ({
				count: file.edits + "×",
				path: shortenPath(file.path),
			}));

			const toolRows = (Array.isArray(timing.tools) ? timing.tools : []).map((row) => ({
				tool: row.tool,
				share: row.share,
				took: formatDuration(row.ms),
				calls: String(row.calls),
			}));

			const money = (Array.isArray(business.topTurns) ? business.topTurns : []).map((row) => ({
				turn: String(row.turn),
				tokens: (row.tokens ?? 0).toLocaleString("en-US"),
				share: row.share + "%",
				tools: String(row.tools),
				outcome: outcomeWord(row.outcome),
			}));

			const unresolved = (Array.isArray(briefing.unresolved) ? briefing.unresolved : []).map((item) => ({
				when: toClock(item.time),
				tool: item.tool,
				code: item.code,
				command: item.command,
			}));

			const weather = briefing.weather;
			const weatherText = weather === null || weather === undefined
				? "Not measured: no live session is attached to this page."
				: weather.contextWindow === null || weather.contextWindow === undefined
					? weather.contextTokens.toLocaleString("en-US") + " context tokens. This model declares no ceiling, so no percentage is claimed."
					: weather.contextTokens.toLocaleString("en-US") + " of " + weather.contextWindow.toLocaleString("en-US") + " context tokens (" + weather.percent + "%)."
						+ (weather.source === "config" ? " The ceiling comes from this plugin's config, not from the model." : "");

			const corrections = briefing.corrections ?? {};
			const correctionsSummary = corrections.toolFailures === 0 && corrections.llmRetries === 0 && corrections.compactions === 0
				? "Clean run: no failures, no retries, no compactions."
				: [
					corrections.toolFailures > 0 ? corrections.toolFailures + (corrections.toolFailures === 1 ? " tool failure" : " tool failures") : null,
					corrections.llmRetries > 0 ? corrections.llmRetries + (corrections.llmRetries === 1 ? " model retry" : " model retries") : null,
					corrections.compactions > 0 ? corrections.compactions + (corrections.compactions === 1 ? " compaction" : " compactions") : null,
				].filter((part) => part !== null).join(", ") + ".";

			// Five items, and the span label is honest about which mode produced it: a
			// windowed read knows how long you were away, a first look does not and
			// reports the span of the events instead of claiming an away duration.
			const dateline = [];
			dateline.push(firstLook ? "whole session" : "since " + toClock(briefing.window?.fromTime));
			dateline.push(firstLook
				? formatDuration(briefing.window?.windowMs ?? 0) + " of work"
				: "away " + formatDuration(briefing.masthead?.awayMs ?? 0));
			const events = briefing.masthead?.events ?? 0;
			dateline.push(events + (events === 1 ? " event" : " events"));
			if (briefing.masthead?.turn !== null && briefing.masthead?.turn !== undefined) dateline.push("turn " + briefing.masthead.turn);
			dateline.push("briefed " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));

			const quiet = lead.kind === "quiet" && actions.length === 0;

			return {
				kind: "paper",
				title: briefing.title ?? briefing.sessionId,
				dateline,
				error: null,
				actions,
				quiet,
				firstLook,
				lead: leadSentence(lead),
				did: {
					turns: String(briefing.masthead?.turns ?? 0),
					finished: String(turns.completed ?? 0),
					bad: String((turns.blocked ?? 0) + (turns.error ?? 0) + (turns.interrupted ?? 0)),
					toolCalls: String(business.toolCalls ?? 0),
					filesTouched: String(briefing.files?.touched ?? 0),
					commands: String(briefing.commands?.total ?? 0),
					commandsFailed: String(briefing.commands?.failed ?? 0),
				},
				timeline,
				files,
				filesTouched: briefing.files?.touched ?? 0,
				delivered: (Array.isArray(business.files) ? business.files : []).map((path) => shortenPath(path)),
				deliveredMore: business.filesTruncated ?? 0,
				toolRows,
				longest: timing.longest?.tool === null || timing.longest === undefined
					? null
					: timing.longest.tool + " " + formatDuration(timing.longest.ms),
				toolShare: timing.toolShare ?? null,
				money,
				figures,
				unresolved,
				failures: correctionsSummary,
				failureGroups: Array.isArray(corrections.failureGroups)
					? corrections.failureGroups.map((group) => group.failure + " ×" + group.count)
					: [],
				asks: (Array.isArray(briefing.asks) ? briefing.asks : []).map((ask) => ask.text),
				weather: weatherText,
				notes: Array.isArray(briefing.notes) ? briefing.notes : [],
				throughSeq: briefing.window?.throughSeq ?? null,
			};
		}

		/** @returns one titled section element. */
		function section(h, key, title, children) {
			return h("section", { key, className: "dmp-section" }, [h("h2", { key: "h" }, title), ...children]);
		}

		/** @returns a horizontally scrollable table. */
		function table(h, key, head, body) {
			return h("div", { key, className: "dmp-scroll" }, h("table", { className: "dmp-table" }, [
				h("thead", { key: "head" }, h("tr", {}, head.map((label, index) => h("th", { key: "h" + index, className: index === 0 ? undefined : "dmp-num" }, label)))),
				h("tbody", { key: "body" }, body),
			]));
		}

		/** @returns the turn timeline table. */
		function turnsTable(h, display) {
			const body = display.timeline.map((row, index) => h("tr", { key: "r" + index }, [
				h("td", { key: "turn" }, "#" + row.turn),
				h("td", { key: "took", className: "dmp-num" }, row.took),
				h("td", { key: "steps", className: "dmp-num" }, row.steps),
				h("td", { key: "tools", className: "dmp-num" }, row.tools),
				h("td", { key: "tokens", className: "dmp-num" }, row.tokens),
				h("td", { key: "outcome", className: row.bad ? "dmp-bad" : (row.open ? "dmp-open" : undefined) }, row.outcome),
			]));
			return table(h, "t", ["turn", "took", "steps", "tools", "tokens", "outcome"], body);
		}

		/** @returns the per-turn spend table. */
		function moneyTable(h, display) {
			const body = display.money.map((row, index) => h("tr", { key: "r" + index }, [
				h("td", { key: "turn" }, "turn " + row.turn),
				h("td", { key: "tokens", className: "dmp-num" }, row.tokens),
				h("td", { key: "share", className: "dmp-num" }, row.share),
				h("td", { key: "outcome" }, row.outcome),
			]));
			return table(h, "t", ["turn", "tokens", "share", "outcome"], body);
		}

		/** @returns the churn or delivered file list. */
		function fileList(h, key, entries, marker) {
			return h("ul", { key, className: "dmp-files" }, entries.map((entry, index) => h("li", { key: "f" + index }, [
				h("span", { key: "c", className: "dmp-count" }, marker === undefined ? entry.count : marker),
				h("span", { key: "p", className: "dmp-path" }, marker === undefined ? entry.path : entry),
			])));
		}

		/**
		 * The paper's pages.
		 *
		 * A page is only offered when it has something to say, so a quiet session
		 * is a single sheet rather than three pages of nothing, and the folio never
		 * claims a page that does not exist.
		 *
		 * @param display - the display model.
		 * @returns `[{ id, label, build }]`, front page first.
		 */
		function pageList(display) {
			const pages = [{
				id: "front",
				label: "Front",
				/** @returns the front page's blocks. */
				build: (h) => {
					const blocks = [];
					if (display.actions.length > 0) {
						const items = display.actions.map((action, index) => h("li", { key: "a" + index }, [
							action.lead,
							h("strong", { key: "s" }, action.strong),
							action.tail,
							h("span", { key: "d", className: "dmp-age" }, action.detail),
						]));
						blocks.push(h("section", { key: "bulletin", className: "dmp-bulletin" }, [
							h("h2", { key: "h" }, "Action required"),
							h("ul", { key: "ul" }, items),
							h("p", { key: "hint", className: "dmp-hint" }, "Answer it in the composer. This page reports, it never acts for you."),
						]));
					}
					if (display.quiet) {
						blocks.push(h("p", { key: "quiet", className: "dmp-quiet" }, "No news. Nothing has happened since you last read this session."));
					} else {
						blocks.push(h("p", { key: "lede", className: "dmp-lede" }, display.lead));
					}
					blocks.push(h("p", { key: "did", className: "dmp-did" }, [
						h("b", { key: "turns" }, display.did.turns + " turns"),
						" · ",
						display.did.finished + " finished",
						" · ",
						h("b", { key: "bad" }, display.did.bad + " ended badly"),
						" · ",
						display.did.toolCalls + " tool calls",
						" · ",
						display.did.filesTouched + " files touched",
						" · ",
						display.did.commands + " commands run (" + display.did.commandsFailed + " failed)",
					]));
					if (display.asks.length > 0) {
						blocks.push(section(h, "asks", "You asked", [
							h("ul", { key: "ul", className: "dmp-asks" }, display.asks.map((ask, index) => h("li", { key: "a" + index }, ask))),
						]));
					}
					blocks.push(section(h, "weather", "Weather", [h("p", { key: "s", className: "dmp-empty" }, display.weather)]));
					return blocks;
				},
			}];

			if (display.timeline.length > 0 || display.unresolved.length > 0) {
				pages.push({
					id: "log",
					label: "The Log",
					/** @returns the log page's blocks. */
					build: (h) => {
						const blocks = [];
						if (display.timeline.length > 0) {
							blocks.push(section(h, "turns", "Turns", [turnsTable(h, display)]));
						}
						if (display.unresolved.length > 0) {
							blocks.push(section(h, "unresolved", "Unresolved (" + display.unresolved.length + ")", [
								h("ul", { key: "ul", className: "dmp-unresolved" }, display.unresolved.map((item, index) => h("li", { key: "u" + index }, [
									h("span", { key: "w", className: "dmp-when" }, item.when),
									item.tool + " failed: ",
									h("span", { key: "c", className: "dmp-code" }, item.code),
									item.command === null ? null : h("span", { key: "cmd", className: "dmp-cmd" }, '"' + item.command + '"'),
								]))),
							]));
						}
						blocks.push(section(h, "corrections", "Corrections", [
							h("p", { key: "s", className: "dmp-empty" }, display.failures),
							...display.failureGroups.map((group, index) => h("p", { key: "g" + index, className: "dmp-group" }, group)),
						]));
						return blocks;
					},
				});
			}

			if (display.files.length > 0 || display.delivered.length > 0 || display.toolRows.length > 0 || display.money.length > 0) {
				pages.push({
					id: "ledger",
					label: "The Ledger",
					/** @returns the ledger page's blocks. */
					build: (h) => {
						const blocks = [];
						if (display.files.length > 0) {
							blocks.push(section(h, "files", "Files (" + display.filesTouched + " touched)", [fileList(h, "ul", display.files)]));
						}
						if (display.delivered.length > 0) {
							const entries = display.deliveredMore > 0
								? [...display.delivered, "and " + display.deliveredMore + " more"]
								: display.delivered;
							blocks.push(section(h, "delivered", "Delivered", [fileList(h, "ul", entries, "→")]));
						}
						if (display.toolRows.length > 0) {
							const children = display.toolRows.map((row, index) => h("div", { key: "t" + index }, [
								h("span", { key: "b", className: "dmp-bar" }, h("i", { style: { width: Math.max(2, row.share) + "%" } })),
								row.tool,
								h("span", { key: "d", className: "dmp-open" }, "  " + row.took + " · " + row.calls + " calls"),
							]));
							if (display.longest !== null) children.push(h("p", { key: "longest", className: "dmp-group" }, "longest single call: " + display.longest));
							if (display.toolShare !== null) children.push(h("p", { key: "share", className: "dmp-group" }, "tool execution was " + display.toolShare + "% of the window; the rest was model time"));
							children.push(h("p", { key: "figs", className: "dmp-group" }, display.figures.join(" · ")));
							blocks.push(section(h, "time", "Where the time went", children));
						}
						if (display.money.length > 0) {
							blocks.push(section(h, "money", "Where the money went", [moneyTable(h, display)]));
						}
						return blocks;
					},
				});
			}

			return pages;
		}

		/**
		 * Build the newspaper page.
		 *
		 * @param h - element factory (`React.createElement` or a test double).
		 * @param display - the display model.
		 * @param handlers - `{ onMarkRead, onRefresh, onForget, onPage, page }`.
		 * @returns the element tree.
		 */
		function paperTree(h, display, handlers) {
			const pages = pageList(display);
			const requested = Number.isSafeInteger(handlers.page) ? handlers.page : 1;
			const current = Math.min(Math.max(1, requested), pages.length);
			const active = pages[current - 1];
			const blocks = [];

			if (current === 1) {
				blocks.push(h("header", { key: "masthead", className: "dmp-masthead" }, [
					h("p", { key: "name", className: "dmp-name" }, "The Morning Paper"),
					h("h1", { key: "title", className: "dmp-title" }, display.title),
					h("div", { key: "dateline", className: "dmp-dateline" }, display.dateline.join("  ·  ")),
				]));
			} else {
				blocks.push(h("header", { key: "runninghead", className: "dmp-runninghead" }, [
					h("b", { key: "name" }, "The Morning Paper"),
					h("span", { key: "title" }, display.title),
					h("span", { key: "folio" }, "Page " + current + " of " + pages.length),
				]));
			}

			if (display.error !== null) {
				blocks.push(h("p", { key: "error", className: "dmp-error" }, display.error.code + ": " + display.error.message));
			}

			if (pages.length > 1) {
				blocks.push(h("nav", { key: "pager", className: "dmp-pager" }, pages.map((page, index) => h("button", {
					key: page.id,
					type: "button",
					className: index + 1 === current ? "dmp-page-on" : undefined,
					onClick: () => handlers.onPage(index + 1),
				}, "Page " + (index + 1) + " · " + page.label))));
			}

			blocks.push(h("div", { key: "pagebody", className: "dmp-pagebody" }, active.build(h, display)));

			// The footer is ONE row: navigation on the left, view controls on the
			// right, like a newspaper's folio line. Small print sits under it, and
			// only when there is something to print.
			// A single-sheet paper needs no navigation at all, so the left side of the
			// folio is simply absent rather than announcing "single page".
			const nav = pages.length > 1
				? h("div", { key: "nav", className: "dmp-nav" }, [
					h("button", { key: "prev", type: "button", disabled: current === 1, onClick: () => handlers.onPage(current - 1) }, "Previous"),
					h("span", { key: "of", className: "dmp-folio-page" }, "Page " + current + " of " + pages.length),
					h("button", { key: "next", type: "button", disabled: current === pages.length, onClick: () => handlers.onPage(current + 1) }, "Next"),
				])
				: null;
			const controls = h("div", { key: "controls", className: "dmp-controls" }, [
				h("button", {
					key: "read",
					type: "button",
					title: "Treat everything up to now as read, so the next thing you see here is what is new",
					disabled: display.throughSeq === null,
					onClick: handlers.onMarkRead,
				}, "Mark all read"),
				h("button", { key: "refresh", type: "button", onClick: handlers.onRefresh }, "Refresh"),
				...(display.firstLook ? [] : [h("button", { key: "forget", type: "button", onClick: handlers.onForget }, "Show whole session")]),
			]);

			const smallPrint = [];
			if (display.firstLook) {
				smallPrint.push(h("li", { key: "first" }, "First look: this page covers the whole session. Mark all read to start tracking from here."));
			}
			for (const [index, note] of display.notes.entries()) smallPrint.push(h("li", { key: "n" + index }, note));

			blocks.push(h("footer", { key: "footer", className: "dmp-smallprint" }, [
				h("div", { key: "folio", className: "dmp-folio" }, [nav, controls]),
				...(handlers.markedReadAt === null || handlers.markedReadAt === undefined
					? []
					: [h("p", { key: "marked", className: "dmp-colophon" },
						"Marked everything up to now as read at " + handlers.markedReadAt + ". The next new events will appear here.")]),
				...(smallPrint.length > 0 ? [h("ul", { key: "ul", className: "dmp-notes" }, smallPrint)] : []),
				h("p", { key: "colophon", className: "dmp-colophon" },
					"Computed from the durable session log. No model was called."),
			]));

			return h("article", { className: "dmp-paper" }, blocks);
		}

		/** @returns a fetch that reports status without throwing on a refusal. */
		async function requestJson(url) {
			const response = await fetch(url, { headers: { accept: "application/json" } });
			const body = await response.json().catch(() => null);
			return { ok: response.ok, status: response.status, body };
		}

		/** @returns the current log tail, or null when the probe failed. */
		async function pollTail(sessionId) {
			const result = await requestJson(ROUTE_PATH + "?probe=1&sessionId=" + encodeURIComponent(sessionId));
			if (result.ok && result.body !== null && typeof result.body.tailSeq === "number") return result.body.tailSeq;
			return null;
		}

		/**
		 * Refresh only if the log actually moved.
		 *
		 * This is what makes auto-refresh affordable: the recurring cost is a
		 * metadata-only tail probe, and the expensive `readSession` happens only
		 * when the tail changed. A failed probe is silent — the next tick retries,
		 * and a transient hiccup should not paint an error over a good page.
		 *
		 * @param sessionId - the visible session.
		 * @param set - state setters `{ setBriefing, setError }`.
		 */
		async function refreshIfChanged(sessionId, set) {
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			if (state.polling) return;
			state.polling = true;
			try {
				const tail = await pollTail(sessionId);
				if (tail === null) return;
				if (tail === state.tailSeq && state.briefing !== null) return;
				await loadBriefing(sessionId, set);
			} catch {
				/* silent by design; the next tick retries */
			} finally {
				state.polling = false;
			}
		}

		/**
		 * Load the page for one session. With a reading marker the window starts
		 * there; without one the whole session is shown, which is what makes a
		 * first visit useful instead of empty.
		 *
		 * @param sessionId - the visible session.
		 * @param set - state setters `{ setBriefing, setError }`.
		 */
		async function loadBriefing(sessionId, set) {
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			state.sessionId = sessionId;
			state.loading = true;
			try {
				const marker = readMarker(sessionId);
				state.marker = marker;
				const query = ROUTE_PATH + "?sessionId=" + encodeURIComponent(sessionId)
					+ (marker === null ? "" : "&sinceSeq=" + String(marker));
				const result = await requestJson(query);
				if (result.ok && result.body !== null && result.body.ok === true) {
					state.briefing = result.body.briefing;
					state.tailSeq = result.body.briefing?.window?.throughSeq ?? state.tailSeq;
					state.error = null;
					set.setBriefing(result.body.briefing);
					set.setError(null);
					return;
				}
				const code = result.body !== null && typeof result.body === "object" && result.body.error !== null && typeof result.body.error === "object"
					? result.body.error.code
					: "HTTP_" + String(result.status);
				if (code === "MARKER_AHEAD") {
					// The marker is meaningless now (log reset, or another browser forked
					// forward): forget it and show the whole session instead of a stale page.
					clearMarker(sessionId);
					const whole = await requestJson(ROUTE_PATH + "?sessionId=" + encodeURIComponent(sessionId));
					if (whole.ok && whole.body !== null && whole.body.ok === true) {
						state.briefing = whole.body.briefing;
						state.tailSeq = whole.body.briefing?.window?.throughSeq ?? state.tailSeq;
						state.error = null;
						set.setBriefing(whole.body.briefing);
						set.setError(null);
						return;
					}
				}
				const message = result.body !== null && typeof result.body === "object" && result.body.error !== null && typeof result.body.error === "object"
					? result.body.error.message
					: "the briefing request failed";
				state.error = { code, message };
				set.setError({ code, message });
			} catch (error) {
				const message = messageOf(error);
				state.error = { code: "NETWORK", message };
				set.setError({ code: "NETWORK", message });
			} finally {
				state.loading = false;
			}
		}

		/**
		 * The Conversation View tab.
		 *
		 * @param props - view slot runtime props: owner `openView`/`viewRequest`, session scope values.
		 * @returns the page, or null when React is unavailable.
		 */
		function MorningPaperView(props) {
			ensureStyles();
			if (React === null) return null;
			const h = React.createElement;
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : undefined;
			const [briefing, setBriefing] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [page, setPage] = React.useState(1);
			const [markedReadAt, setMarkedReadAt] = React.useState(null);
			const running = typeof props.useSession === "function" ? props.useSession((snapshot) => snapshot?.running) : undefined;

			const load = React.useCallback(() => {
				void loadBriefing(sessionId, { setBriefing, setError });
			}, [sessionId]);

			const refresh = React.useCallback(() => {
				void refreshIfChanged(sessionId, { setBriefing, setError });
			}, [sessionId]);

			React.useEffect(() => {
				load();
			}, [load]);

			// Open on the front page whenever the session changes, with no stale
			// confirmation from the previous one.
			React.useEffect(() => {
				setPage(1);
				setMarkedReadAt(null);
			}, [sessionId]);

			// A turn that just ended is the main event a briefing exists to report,
			// and the durable events land a beat after the run state flips.
			React.useEffect(() => {
				if (running !== false) return undefined;
				const timer = setTimeout(refresh, SETTLE_DELAY_MS);
				return () => clearTimeout(timer);
			}, [running, refresh]);

			// Coming back to the tab is the other moment that matters.
			React.useEffect(() => {
				const onWake = () => {
					if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
					refresh();
				};
				window.addEventListener("focus", onWake);
				document.addEventListener("visibilitychange", onWake);
				return () => {
					window.removeEventListener("focus", onWake);
					document.removeEventListener("visibilitychange", onWake);
				};
			}, [refresh]);

			// Steady state: poll faster while the agent is working, slower when it is
			// idle, and never while the tab is in the background.
			React.useEffect(() => {
				const period = running === true ? ACTIVE_POLL_MS : IDLE_POLL_MS;
				const timer = setInterval(() => {
					if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
					refresh();
				}, period);
				return () => clearInterval(timer);
			}, [running, refresh]);

			if (sessionId === undefined) return null;
			const display = summarize(briefing, error);
			if (display === null) {
				return h("article", { className: "dmp-paper" }, h("p", { className: "dmp-quiet" }, "Setting the type…"));
			}
			const handlers = {
				page,
				onPage: setPage,
				onRefresh: load,
				markedReadAt,
				onMarkRead: () => {
					markAllRead(sessionId, display, { setBriefing, setMarkedReadAt });
				},
				onForget: () => {
					clearMarker(sessionId);
					load();
				},
			};
			return paperTree(h, display, handlers);
		}

		/** Client services this plugin reads. */
		const inject = ["slots"];

		/**
		 * Register the view tab.
		 * @param ctx - client plugin context.
		 */
		function apply(ctx) {
			try {
				ctx.slots.inject("conversation.view", () => ctx.slots.register({
					name: "conversation.view",
					id: "morning-paper",
					order: 20,
					label: () => "Morning Paper",
				}, MorningPaperView));
			} catch (error) {
				// A tab that cannot attach must never take the client down with it.
				console.warn("morning-paper: could not register the view entry:", messageOf(error));
			}
		}

		exports.MorningPaperView = MorningPaperView;
		exports.paperTree = paperTree;
		exports.pageList = pageList;
		exports.markAllRead = markAllRead;
		exports.formatTokens = formatTokens;
		exports.summarize = summarize;
		exports.leadSentence = leadSentence;
		exports.formatDuration = formatDuration;
		exports.markerKey = markerKey;
		exports.readMarker = readMarker;
		exports.writeMarker = writeMarker;
		exports.clearMarker = clearMarker;
		exports.loadBriefing = loadBriefing;
		exports.refreshIfChanged = refreshIfChanged;
		exports.pollTail = pollTail;
		exports.ACTIVE_POLL_MS = ACTIVE_POLL_MS;
		exports.IDLE_POLL_MS = IDLE_POLL_MS;
		exports.ensureStyles = ensureStyles;
		exports.PAPER_CSS = PAPER_CSS;
		exports.PAPER_TOKENS = PAPER_TOKENS;
		exports.STYLE_ID = STYLE_ID;
		exports.state = state;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

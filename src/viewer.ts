/**
 * Viewer process — the program that runs inside each subagent pane.
 *
 * Usage: bun src/viewer.ts <session-id|session-file> [--session-dir <dir>] [--title <label>]
 *        [--parent-pid <pid>] [--socket <path> --token <token>]
 *
 * The terminal view follows the persisted transcript and optional live snapshots.
 * It is read-only and exits when its parent process disappears.
 */

import { watch } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { readConfig, shellQuote } from "./config.ts";
import { createHerdrCli } from "./herdr.ts";
import { PaneManager } from "./pane-manager.ts";
import { SessionTree } from "./session-tree.ts";
import { createTernBackend, createTmuxBackend, detectPaneContext, type PaneBackend } from "./terminal-backend.ts";
import { createLineSplitter } from "./line-splitter.ts";
import { type RenderOptions, type SessionTotals, recordOf, renderEntry, sanitize, usageOf } from "./render.ts";
import { TranscriptModel } from "./tui-model.ts";
import { ViewerTui } from "./tui.ts";
import { resolveSessionFile } from "./session-file.ts";

const USAGE = "usage: viewer <session-id|session-file> [--session-dir <dir>] [--title <label>] [--thinking <n>] [--parent-pid <n>] [--socket <path> --token <token>]";
const DEFAULT_THINKING_LINES = 2;
/** Poll cadence while the transcript file does not exist yet. */
const POLL_INTERVAL_MS = 250;
/** Watch events alone are unreliable, so the tail loop also wakes on an interval. */
const TAIL_INTERVAL_MS = 250;
/** Slower cadence after `session_exit`; the watch still fires if the subagent is revived. */
const EXIT_TAIL_INTERVAL_MS = 2000;
/** How often the parent-process watchdog checks that its pid is still alive. */
const PARENT_CHECK_INTERVAL_MS = 1000;
const DEFAULT_WIDTH = 80;
const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

interface ViewerOptions {
	sessionFile: string;
	sessionDir?: string;
	title: string;
	thinkingLines: number;
	parentPid: number | null;
	socketPath: string | null;
	token: string | null;
	streamUnavailable: boolean;
	managed: boolean;
	paneId: string | null;
}

/** Per-session accounting shared between the tail loop and the renderer. */
interface TailState {
	totals: SessionTotals;
	ircCalls: NonNullable<RenderOptions["ircCalls"]>;
	startMs: number | null;
	onSessionExit: () => void;
	model?: TranscriptModel;
	tui?: ViewerTui;
}

/**
 * Parse the CLI arguments. Returns `null` when the required `<sessionFile>` is missing.
 * An unusable `--thinking` value falls back to the default rather than failing the run.
 */
function parseViewerArgs(argv: readonly string[]): ViewerOptions | null {
	let sessionFile: string | null = null;
	let title: string | null = null;
	let thinkingLines = DEFAULT_THINKING_LINES;
	let parentPid: number | null = null;
	let socketPath: string | null = null;
	let token: string | null = null;
	let streamUnavailable = false;
	let managed = false;
	let paneId: string | null = null;
	let sessionDir: string | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--title") {
			const value = argv[index + 1];
			if (value !== undefined) {
				title = value;
				index += 1;
			}
			continue;
		}
		if (arg === "--session-dir") {
			sessionDir = argv[index + 1];
			if (sessionDir !== undefined) index += 1;
			continue;
		}
		if (arg === "--thinking") {
			const value = argv[index + 1];
			const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
			if (Number.isInteger(parsed) && parsed >= 0) {
				thinkingLines = parsed;
				index += 1;
			}
			continue;
		}
		if (arg === "--parent-pid") {
			const value = argv[index + 1];
			const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
			if (Number.isInteger(parsed) && parsed > 0) {
				parentPid = parsed;
				index += 1;
			}
			continue;
		}
		if (arg === "--stream-unavailable") {
			streamUnavailable = true;
			continue;
		}
		if (arg === "--managed") {
			managed = true;
			continue;
		}
		if (arg === "--pane-id") {
			paneId = argv[index + 1] ?? null;
			if (paneId !== null) index += 1;
			continue;
		}
		if (arg === "--socket" || arg === "--token") {
			const value = argv[index + 1];
			if (value !== undefined) {
				if (arg === "--socket") socketPath = value;
				else token = value;
				index += 1;
			}
			continue;
		}
		if (arg !== undefined && sessionFile === null && !arg.startsWith("--")) {
			sessionFile = arg;
		}
	}

	if (sessionFile === null || sessionFile.length === 0) return null;
	return { sessionFile, sessionDir, title: title ?? basenameWithoutJsonl(sessionFile), thinkingLines, parentPid, socketPath, token, streamUnavailable, managed, paneId };
}

/** Last path segment, with a `.jsonl` suffix removed. */
function basenameWithoutJsonl(path: string): string {
	const segments = path.split(/[\\/]/u);
	const base = segments[segments.length - 1] ?? path;
	return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return String(error);
}

const reportedProblems = new Set<string>();

/** Report a problem once, then stay quiet so a persistent failure cannot flood the pane. */
function reportProblem(context: string, error: unknown): void {
	const problem = `${context}: ${describeError(error)}`;
	if (reportedProblems.has(problem)) return;
	reportedProblems.add(problem);
	process.stderr.write(`viewer: ${problem}\n`);
}

/** Milliseconds of an entry's top-level ISO `timestamp`, or null when absent/unparsable. */
function entryTimestamp(entry: unknown): number | null {
	const record = recordOf(entry);
	const value = record === null ? null : record["timestamp"];
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function isSessionExit(entry: unknown): boolean {
	const record = recordOf(entry);
	return record !== null && record["type"] === "custom" && record["customType"] === "session_exit";
}

/**
 * Fold one entry into the running totals: assistant usage adds up, the first entry with a
 * timestamp marks the session start, and the `session_exit` entry fixes the duration.
 */
function accumulate(entry: unknown, state: TailState): void {
	const usage = usageOf(entry);
	if (usage !== null) {
		state.totals.tokens += usage.tokens;
		state.totals.cost += usage.cost;
	}
	if (state.startMs === null) state.startMs = entryTimestamp(entry);
	if (isSessionExit(entry)) {
		const endMs = entryTimestamp(entry);
		state.totals.durationMs = state.startMs === null || endMs === null ? null : endMs - state.startMs;
	}
}

function renderTranscriptLine(line: string, options: ViewerOptions, state: TailState): void {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return; // a partially written or malformed line is skipped silently
	}

	accumulate(entry, state);
	if (state.model && state.tui) {
		const changed = state.model.append(entry);
		if (isSessionExit(entry)) {
			const summary = renderEntry(entry, { width: 1000, color: false, thinkingLines: 0, totals: state.totals }).join("\n");
			state.model.cards.push({ id: `summary:${state.model.cards.length}`, kind: "status", title: "SUMMARY", body: summary, expanded: false });
			if (state.model.follow) state.model.selected = state.model.cards.length - 1;
			state.onSessionExit();
		}
		if (changed) state.tui.requestRender();
		return;
	}
	const rendered = renderEntry(entry, {
		width: process.stdout.columns || DEFAULT_WIDTH,
		color: process.stdout.isTTY === true,
		thinkingLines: options.thinkingLines,
		totals: state.totals,
		ircCalls: state.ircCalls,
	});
	if (rendered.length === 0) return; // entry types the renderer ignores produce no blank lines
	process.stdout.write(`${rendered.join("\n")}\n`);
	if (isSessionExit(entry)) state.onSessionExit();
}

/** Poll until the transcript file exists (it appears 1–5 s after the subagent starts). */
async function waitForTranscript(sessionFile: string): Promise<void> {
	if (await Bun.file(sessionFile).exists()) return;
	if (!process.stdout.isTTY) process.stdout.write("waiting for transcript…\n");
	while (!(await Bun.file(sessionFile).exists())) {
		await new Promise<void>((resolve) => {
			setTimeout(resolve, POLL_INTERVAL_MS);
		});
	}
}

/**
 * Tail the transcript from byte 0. Each wake reads whatever was appended since the last read;
 * at most one read is in flight at a time, and a wake arriving during a read schedules exactly
 * one follow-up read.
 */
async function startTailLoop(options: ViewerOptions, model?: TranscriptModel, tui?: ViewerTui): Promise<void> {
	const splitter = createLineSplitter();
	let offset = 0;
	let reading = false;
	let wakePending = false;
	let intervalMs = TAIL_INTERVAL_MS;

	const state: TailState = {
		totals: { tokens: 0, cost: 0, durationMs: null },
		ircCalls: new Map(),
		startMs: null,
		model,
		tui,
		onSessionExit: () => setIntervalMs(EXIT_TAIL_INTERVAL_MS),
	};

	const readNewBytes = async (): Promise<void> => {
		let size: number;
		try {
			size = (await Bun.file(options.sessionFile).stat()).size;
		} catch {
			return; // momentarily gone (rotated/replaced); the next wake retries
		}
		if (size < offset) {
			offset = 0; // truncated or replaced
			splitter.reset();
			state.ircCalls.clear();
			if (state.model) {
				state.model.cards = [];
				state.model.selected = 0;
				state.model.model = "";
				state.model.agent = "";
				state.totals = { tokens: 0, cost: 0, durationMs: null };
				state.startMs = null;
			}
		}
		if (size <= offset) return;

		const chunk = await Bun.file(options.sessionFile).slice(offset, size).bytes();
		offset += chunk.length;
		if (intervalMs !== TAIL_INTERVAL_MS) setIntervalMs(TAIL_INTERVAL_MS); // revived subagent
		for (const line of splitter.push(chunk)) renderTranscriptLine(line, options, state);
	};

	const pump = async (): Promise<void> => {
		if (reading) {
			wakePending = true;
			return;
		}
		reading = true;
		try {
			await readNewBytes();
			while (wakePending) {
				wakePending = false;
				await readNewBytes();
			}
		} catch (error) {
			reportProblem("read failed", error);
		} finally {
			reading = false;
		}
	};

	const wake = (): void => {
		void pump();
	};

	const setIntervalMs = (ms: number): void => {
		if (ms === intervalMs) return;
		intervalMs = ms;
		clearInterval(intervalHandle);
		intervalHandle = setInterval(wake, ms);
	};

	let intervalHandle = setInterval(wake, intervalMs);
	try {
		watch(options.sessionFile, wake);
	} catch (error) {
		reportProblem("watch failed", error);
	}
	await pump();
}

/**
 * Watch the omp process that spawned this viewer and exit once it is gone, so a SIGKILLed omp
 * cannot leave orphaned viewers behind. `EPERM` (process exists, different user) counts as alive.
 */
function watchParent(pid: number, quit: () => void): void {
	setInterval(() => {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ESRCH") quit();
		}
	}, PARENT_CHECK_INTERVAL_MS);
}

/** SIGTERM/SIGHUP/SIGINT end the viewer cleanly; every other failure is reported and survived. */
function installProcessHandlers(quit: () => void): void {
	for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
		process.on(signal, quit);
	}
	process.on("uncaughtException", (error: Error) => {
		reportProblem("unexpected error", error);
	});
	process.on("unhandledRejection", (reason: unknown) => {
		reportProblem("unhandled rejection", reason);
	});
}

/** Connect to the parent's private live-event broker; transcript files remain authoritative. */
function connectLive(path: string, token: string, model: TranscriptModel, tui: ViewerTui): void {
	const connect = () => {
		model.streamStatus = "connecting";
		tui.requestRender();
		const socket: Socket = createConnection(path);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify({ token })}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					const frame = recordOf(JSON.parse(line));
					if (frame?.["type"] === "live" && Array.isArray(frame["content"])) model.setLive(frame["content"]);
					else if (frame?.["type"] === "clear") model.clearLive();
					else if (frame?.["type"] === "event" && typeof frame["name"] === "string" && typeof frame["text"] === "string") model.appendLiveEvent(frame["name"], frame["text"], typeof frame["toolCallId"] === "string" ? frame["toolCallId"] : undefined);
					else if (frame?.["type"] === "state" && typeof frame["status"] === "string") model.status = frame["status"];
					else if (frame?.["type"] === "stream_error") model.streamStatus = "unavailable";
					if (frame?.["type"] !== "stream_error") model.streamStatus = "live";
					tui.requestRender();
				} catch {
					socket.destroy();
					return;
				}
				newline = buffer.indexOf("\n");
			}
			if (buffer.length > 1024 * 1024) socket.destroy();
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			model.streamStatus = "unavailable";
			tui.requestRender();
			setTimeout(connect, 1000).unref();
		});
	};
	connect();
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return;
	}
	const options = parseViewerArgs(args);
	if (options === null) {
		process.stderr.write(`${USAGE}\n`);
		process.exit(2);
	}
	options.sessionFile = await resolveSessionFile(options.sessionFile, options.sessionDir);

	const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
	const model = interactive ? new TranscriptModel() : undefined;
	if (model && options.streamUnavailable) model.streamStatus = "unavailable";
	if (model && !options.socketPath && !options.streamUnavailable) model.status = "history";
	let children: SessionTree | undefined;
	let panes: PaneManager | undefined;
	let stopping = false;
	const quit = (): void => {
		if (stopping) return;
		stopping = true;
		children?.close();
		tui?.stop();
		void (async () => {
			await panes?.closeAll();
			process.exit(0);
		})();
	};
	const tui = model ? new ViewerTui(model, options.title, options.sessionFile, quit) : undefined;
	installProcessHandlers(quit);
	if (options.parentPid !== null) {
		let handlingParentExit = false;
		watchParent(options.parentPid, () => {
			if (handlingParentExit) return;
			handlingParentExit = true;
			void (async () => {
				try {
					const context = detectPaneContext(process.env);
					if (options.managed && options.paneId && context?.paneId === options.paneId) {
						if (context.backend === "tern") {
							await createTernBackend(context.paneId).closeCurrent?.();
						} else if (context.backend === "tmux") {
							await createTmuxBackend(context.paneId, context.tmuxEnv).closeCurrent?.();
						} else if (context.backend === "herdr") {
							const backend = createHerdrCli();
							if ((await backend.layout(context.paneId)).some((pane) => pane.paneId === context.paneId)) await backend.close(context.paneId);
						}
					}
				} catch (error) {
					reportProblem("orphan pane cleanup failed", error);
				} finally {
					quit();
				}
			})();
		});
	}
	if (interactive && !options.managed) {
		const config = readConfig(process.env);
		const context = detectPaneContext(process.env);
		const bun = Bun.which("bun");
		if (config && context && bun) {
			try {
				let backend: PaneBackend;
				if (context.backend === "herdr") backend = createHerdrCli();
				else if (context.backend === "tern") backend = createTernBackend(context.paneId);
				else if (context.backend === "tmux") backend = createTmuxBackend(context.paneId, context.tmuxEnv);
				else throw new Error("unsupported terminal pane");
				const viewer = fileURLToPath(import.meta.url);
				panes = new PaneManager(backend, {
					...config,
					monitorPanes: true,
					viewerCommand: (file, label, paneId) => ` exec ${shellQuote(bun)} ${shellQuote(viewer)} ${shellQuote(file)} --title ${shellQuote(label)} --parent-pid ${process.pid} --managed --pane-id ${shellQuote(paneId)}`,
				}, (message, details) => reportProblem(message, details));
				children = new SessionTree(options.sessionFile, panes, (error) => reportProblem("session discovery failed", error));
				children.start();
			} catch (error) {
				reportProblem("pane backend unavailable", error);
			}
		}
	}
	if (tui) tui.start();
	else process.stdout.write(`${CLEAR_SCREEN}${BOLD}${sanitize(options.title).replace(/\n/gu, " ")}${RESET}\nFile: ${sanitize(options.sessionFile).replace(/\r?\n/gu, " ")}\n\n`);
	await waitForTranscript(options.sessionFile);
	await startTailLoop(options, model, tui);
	if (model && tui && options.socketPath && options.token) connectLive(options.socketPath, options.token, model, tui);
}

void main().catch((error: unknown) => {
	reportProblem("startup failed", error);
	process.exitCode = 1;
});

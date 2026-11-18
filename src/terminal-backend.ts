import type { Herdr, LayoutPane } from "./herdr.ts";

type Direction = "right" | "down";
type CliCall = (args: string[]) => Promise<string>;
export type PaneContext =
	| { backend: "tmux"; paneId: string; tmuxEnv: string }
	| { backend: "herdr" | "tern"; paneId: string };

/** Resolve only identities explicitly inherited from the current terminal process. */
export function detectPaneContext(env: Record<string, string | undefined>): PaneContext | null {
	const tmuxEnv = env["TMUX"];
	const tmuxPaneId = env["TMUX_PANE"];
	if (tmuxEnv && tmuxPaneId) return { backend: "tmux", paneId: tmuxPaneId, tmuxEnv };
	const herdrPaneId = env["HERDR_PANE_ID"];
	if (herdrPaneId) return { backend: "herdr", paneId: herdrPaneId };
	const ternPaneId = env["TERN_PANE"];
	if (ternPaneId) return { backend: "tern", paneId: ternPaneId };
	return null;
}

/** A backend advertises unsupported operations instead of pretending to perform them. */
type PaneBackendBase = Pick<Herdr, "run" | "close" | "layout"> & {
	rename?: Herdr["rename"];
	supportsLayoutPosition?: boolean;
	closeCurrent?: () => Promise<void>;
};
export type PaneBackendWithRatio = PaneBackendBase & { supportsRatio?: true; split: Herdr["split"] };
export type PaneBackendWithoutRatio = PaneBackendBase & {
	supportsRatio: false;
	split(target: string, direction: Direction): Promise<string>;
};
export type PaneBackend = PaneBackendWithRatio | PaneBackendWithoutRatio;

class PaneBackendError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "PaneBackendError";
	}
}

const CLI_TIMEOUT_MS = 5000;

/** The CLI always receives argv, never a command interpolated into a local shell. */
async function runCli(bin: string, args: string[]): Promise<string> {
	const proc = (() => {
		try {
			return Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
		} catch {
			throw new PaneBackendError("spawn_failed", `${bin} could not be started`);
		}
	})();
	let timer: Timer | undefined;
	const { promise: timeout, reject } = Promise.withResolvers<never>();
	timer = setTimeout(() => {
		proc.kill("SIGKILL");
		reject(new PaneBackendError("timeout", `${bin} command timed out`));
	}, CLI_TIMEOUT_MS);
	let stdout: string;
	let stderr: string;
	let status: number;
	try {
		[stdout, stderr, status] = await Promise.race([
			Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
			timeout,
		]);
	} finally {
		clearTimeout(timer);
	}
	if (status !== 0) {
		// A run command may contain the live-bridge token; do not log its CLI output.
		const sensitive = args.includes("run") || args.includes("send-keys") || args.includes("-T");
		const detail = sensitive ? "" : (stderr.trim() || stdout.trim());
		throw new PaneBackendError("cli_failed", `${bin} exited with code ${status}${detail ? `: ${detail}` : ""}`);
	}
	return stdout.trim();
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function ternId(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
	if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value) && Number.isSafeInteger(Number(value))) return value;
	return undefined;
}

function tmuxId(value: string): boolean {
	return /^%(?:0|[1-9]\d*)$/u.test(value);
}

function parsedJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new PaneBackendError("bad_response", "terminal CLI returned invalid JSON");
	}
}

function assertSingleLineCommand(command: string): void {
	if (/[\u0000-\u001f\u007f-\u009f]/u.test(command)) {
		throw new PaneBackendError("unsafe_command", "viewer command contains terminal control characters");
	}
}

interface Snapshot {
	panes: LayoutPane[];
	ids: Set<string>;
}

/** Control only blocks created by this instance, and only in the caller's original tab. */
export function createTernBackend(mainPaneId: string, call: CliCall = (args) => runCli("tern", args)): PaneBackendWithoutRatio {
	if (ternId(mainPaneId) !== mainPaneId) throw new PaneBackendError("invalid_pane", "invalid current Tern pane id");
	const owned = new Set<string>();
	let originalTab: string | undefined;

	async function snapshot(allowMissingMain = false): Promise<Snapshot> {
		const root = record(parsedJson(await call(["ls", "--json"])));
		if (!root || !Array.isArray(root["sessions"])) throw new PaneBackendError("bad_response", "Tern sessions are missing");
		let found: { tab: Record<string, unknown>; sessionId: string; tabId: string } | undefined;
		let original: typeof found;
		for (const sessionValue of root["sessions"]) {
			const session = record(sessionValue);
			const sessionId = ternId(session?.["id"]);
			if (!session || sessionId === undefined || !Array.isArray(session["tabs"])) throw new PaneBackendError("bad_response", "malformed Tern session");
			for (const tabValue of session["tabs"]) {
				const tab = record(tabValue);
				const tabId = ternId(tab?.["id"]);
				if (!tab || tabId === undefined || !Array.isArray(tab["blocks"])) throw new PaneBackendError("bad_response", "malformed Tern tab");
				if (`${sessionId}:${tabId}` === originalTab) original = { tab, sessionId, tabId };
				if (tab["blocks"].some((value: unknown) => ternId(record(value)?.["id"]) === mainPaneId)) {
					if (found) throw new PaneBackendError("bad_response", "current Tern pane is ambiguous");
					found = { tab, sessionId, tabId };
				}
			}
		}
		if (!found && allowMissingMain) found = original;
		if (!found) throw new PaneBackendError("pane_not_found", "current Tern pane is no longer present");
		const tabKey = `${found.sessionId}:${found.tabId}`;
		if (originalTab !== undefined && originalTab !== tabKey) throw new PaneBackendError("pane_moved", "current Tern pane moved to another tab");
		originalTab = tabKey;
		const panes: LayoutPane[] = [];
		const ids = new Set<string>();
		for (const value of found.tab["blocks"] as unknown[]) {
			const block = record(value);
			const paneId = ternId(block?.["id"]);
			const width = block?.["cols"];
			const height = block?.["rows"];
			if (paneId === undefined || ids.has(paneId) || typeof width !== "number" || !Number.isFinite(width) || width < 0 || typeof height !== "number" || !Number.isFinite(height) || height < 0) {
				throw new PaneBackendError("bad_response", "malformed Tern block");
			}
			ids.add(paneId);
			panes.push({ paneId, rect: { x: 0, y: 0, width, height } });
		}
		return { panes, ids };
	}

	function requireOwned(paneId: string): void {
		if (!owned.has(paneId)) throw new PaneBackendError("not_owned", "refusing to operate on a pane not created by this backend");
	}

	return {
		supportsRatio: false,
		supportsLayoutPosition: false,
		async split(target, direction) {
			if (target !== mainPaneId) requireOwned(target);
			const before = await snapshot();
			if (!before.ids.has(target)) throw new PaneBackendError("pane_not_found", "Tern split target no longer exists");
			const result = record(parsedJson(await call(["split", target, direction, "--keep-open", "--json"])));
			const paneId = ternId(result?.["block"]);
			if (paneId === undefined || before.ids.has(paneId) || owned.has(paneId)) throw new PaneBackendError("bad_response", "Tern did not return a new block id");
			owned.add(paneId);
			return paneId;
		},
		async run(paneId, command) {
			requireOwned(paneId);
			assertSingleLineCommand(command);
			if (!(await snapshot()).ids.has(paneId)) throw new PaneBackendError("pane_not_found", "Tern viewer pane no longer exists");
			await call(["run", paneId, command]);
		},
		async close(paneId) {
			requireOwned(paneId);
			if ((await snapshot(true)).ids.has(paneId)) await call(["close", paneId, "--json"]);
			owned.delete(paneId);
		},
		async closeCurrent() {
			await snapshot();
			await call(["close", mainPaneId, "--json"]);
		},
		async layout(paneId) {
			if (paneId !== mainPaneId) throw new PaneBackendError("not_owned", "layout must be anchored to the current Tern pane");
			return (await snapshot()).panes;
		},
	};
}

/** Control only panes created by this instance, on the same tmux server as the caller. */
export function createTmuxBackend(mainPaneId: string, tmuxEnv: string, call: CliCall = (args) => runCli("tmux", args)): PaneBackendWithRatio {
	if (!tmuxId(mainPaneId)) throw new PaneBackendError("invalid_pane", "invalid current tmux pane id");
	const server = /^(.*),(\d+),\d+$/u.exec(tmuxEnv);
	if (!server || !server[1] || !server[2] || Number(server[2]) <= 0) throw new PaneBackendError("invalid_server", "invalid TMUX server identity");
	const socket = server[1];
	const pid = server[2];
	const owned = new Set<string>();
	const invoke = (args: string[]): Promise<string> => call(["-S", socket, ...args]);

	async function snapshot(anchor = mainPaneId): Promise<Snapshot> {
		const identity = await invoke(["display-message", "-p", "-t", anchor, "#{pid}\t#{pane_id}"]);
		if (identity !== `${pid}\t${anchor}`) throw new PaneBackendError("server_changed", "tmux server or current pane changed");
		const output = await invoke(["list-panes", "-t", anchor, "-F", "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}"]);
		const panes: LayoutPane[] = [];
		const ids = new Set<string>();
		for (const line of output.split("\n")) {
			const fields = line.split("\t");
			const paneId = fields[0];
			if (fields.length !== 5 || paneId === undefined || !tmuxId(paneId) || ids.has(paneId) || fields.slice(1).some((v) => !/^\d+$/u.test(v))) {
				throw new PaneBackendError("bad_response", "malformed tmux pane layout");
			}
			ids.add(paneId);
			panes.push({ paneId, rect: { x: Number(fields[1]), y: Number(fields[2]), width: Number(fields[3]), height: Number(fields[4]) } });
		}
		if (!ids.has(anchor)) throw new PaneBackendError("pane_not_found", "current tmux pane is no longer present");
		return { panes, ids };
	}

	function requireOwned(paneId: string): void {
		if (!owned.has(paneId)) throw new PaneBackendError("not_owned", "refusing to operate on a pane not created by this backend");
	}

	return {
		supportsRatio: true,
		async split(target, direction, ratio) {
			if (target !== mainPaneId) requireOwned(target);
			if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) throw new PaneBackendError("invalid_ratio", "tmux split ratio must be between 0 and 1");
			const before = await snapshot();
			if (!before.ids.has(target)) throw new PaneBackendError("pane_not_found", "tmux split target no longer exists");
			const paneId = await invoke(["split-window", "-d", direction === "right" ? "-h" : "-v", "-t", target, "-l", `${Math.round((1 - ratio) * 100)}%`, "-P", "-F", "#{pane_id}"]);
			if (!tmuxId(paneId) || before.ids.has(paneId) || owned.has(paneId)) throw new PaneBackendError("bad_response", "tmux did not return a new pane id");
			owned.add(paneId);
			return paneId;
		},
		async run(paneId, command) {
			requireOwned(paneId);
			assertSingleLineCommand(command);
			if (!(await snapshot()).ids.has(paneId)) throw new PaneBackendError("pane_not_found", "tmux viewer pane no longer exists");
			await invoke(["send-keys", "-t", paneId, "-l", "--", command]);
			await invoke(["send-keys", "-t", paneId, "Enter"]);
		},
		async rename(paneId, label) {
			requireOwned(paneId);
			if (!(await snapshot()).ids.has(paneId)) throw new PaneBackendError("pane_not_found", "tmux viewer pane no longer exists");
			await invoke(["select-pane", "-t", paneId, "-T", label]);
		},
		async close(paneId) {
			requireOwned(paneId);
			let panes: Snapshot;
			try {
				panes = await snapshot();
			} catch (error) {
				if (error instanceof PaneBackendError && (error.code === "server_changed" || error.code === "bad_response")) throw error;
				panes = await snapshot(paneId);
			}
			if (panes.ids.has(paneId)) await invoke(["kill-pane", "-t", paneId]);
			owned.delete(paneId);
		},
		async closeCurrent() {
			await snapshot();
			await invoke(["kill-pane", "-t", mainPaneId]);
		},
		async layout(paneId) {
			if (paneId !== mainPaneId) throw new PaneBackendError("not_owned", "layout must be anchored to the current tmux pane");
			return (await snapshot()).panes;
		},
	};
}

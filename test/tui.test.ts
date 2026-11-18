import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveBridge } from "../src/live-bridge.ts";
import { LiveEvents } from "../src/live-events.ts";

const viewerEnv = { ...process.env, TMUX: "", TMUX_PANE: "", HERDR_PANE_ID: "", TERN_PANE: "" };

test("copies the complete session path with p without changing the viewer selection", async () => {
	const bun = Bun.which("bun");
	if (!bun) throw new Error("standalone Bun is required");
	const session = join(tmpdir(), `viewer-路径-${crypto.randomUUID()}`, "session.jsonl");
	let output = "";
	let notify: (() => void) | undefined;
	const terminal = new Bun.Terminal({
		cols: 24,
		rows: 7,
		data(_terminal, data) {
			output += new TextDecoder().decode(data);
			notify?.();
		},
	});
	const child = Bun.spawn([bun, fileURLToPath(new URL("../src/viewer.ts", import.meta.url)), session], { terminal, env: viewerEnv, timeout: 8000 });
	const waitFor = async (needle: string, raw = false) => {
		if ((raw ? output : Bun.stripANSI(output)).includes(needle)) return;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		void child.exited.then(code => reject(new Error(`Viewer exited before ${needle} (${code})`)));
		notify = () => { if ((raw ? output : Bun.stripANSI(output)).includes(needle)) resolve(); };
		try { await promise; } finally { notify = undefined; }
	};
	try {
		await waitFor("Waiting for transcript");
		const initial = Bun.stripANSI(output).split(/\r?\n/u);
		expect(initial[0]).toContain("history");
		expect(initial[0]).toContain("file");
		expect(initial[0]).not.toContain("session.jsonl");
		expect(initial[1]).toContain("Waiting for transcript");
		output = "";
		terminal.write("p");
		const expected = `\x1b]52;c;${Buffer.from(session, "utf8").toString("base64")}\x07`;
		await waitFor(expected, true);
		await waitFor("Clipboard copy requested");
		expect(output).toContain(expected);
		expect(Bun.stripANSI(output).split(/\r?\n/u)[0]).toBe(initial[0]);
		expect(Bun.stripANSI(output)).toContain("Waiting for transcript");
		expect(Bun.stripANSI(output)).not.toContain("SESSION FILE");
	} finally {
		child.kill();
		terminal.close();
		await child.exited;
	}
}, 10000);

test("shows live execution progress inside its tool call", async () => {
	const dir = await mkdtemp(join(tmpdir(), "viewer-progress-"));
	const session = join(dir, "session.jsonl");
	await writeFile(session, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [
		{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "work" } },
	] } })}\n`);
	const bridge = new LiveBridge(() => {});
	await bridge.ready;
	const token = bridge.register("agent");
	const events = new LiveEvents(bridge);
	events.handle({ id: "agent", event: {
		type: "tool_execution_update", toolCallId: "call-1", args: { command: "x".repeat(100_000) },
		partialResult: { content: [{ type: "text", text: "working now" }] },
	} });
	let output = "";
	let notify: (() => void) | undefined;
	const terminal = new Bun.Terminal({
		cols: 100, rows: 20,
		data(_terminal, data) { output += new TextDecoder().decode(data); notify?.(); },
	});
	const child = Bun.spawn([Bun.which("bun")!, fileURLToPath(new URL("../src/viewer.ts", import.meta.url)),
		session, "--socket", bridge.socketPath, "--token", token], { terminal, env: viewerEnv, timeout: 8000 });
	const waitFor = async (needle: string) => {
		if (Bun.stripANSI(output).includes(needle)) return;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		void child.exited.then(code => reject(new Error(`Viewer exited before ${needle} (${code})`)));
		notify = () => { if (Bun.stripANSI(output).includes(needle)) resolve(); };
		try { await promise; } finally { notify = undefined; }
	};
	try {
		await waitFor("TOOL bash");
		terminal.write("T");
		await waitFor("working now");
		const screen = Bun.stripANSI(output);
		expect(screen).toContain("EVENT tool_execution_update");
		expect(screen).toContain("TOOL bash");
	} finally {
		child.kill();
		terminal.close();
		await child.exited;
		events.close();
		await bridge.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 10000);

test("renders merged tool, IRC and review events in the live viewer", async () => {
	const dir = await mkdtemp(join(tmpdir(), "viewer-events-"));
	const session = join(dir, "session.jsonl");
	await writeFile(session, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [
		{ type: "toolCall", id: "call", name: "bash", arguments: { command: "work" } },
	] } })}\n`);
	const bridge = new LiveBridge(() => {});
	await bridge.ready;
	const token = bridge.register("agent");
	const events = new LiveEvents(bridge);
	for (const event of [
		{ type: "tool_approval_requested", toolCallId: "call", reason: "approval reason" },
		{ type: "tool_execution_end", toolCallId: "call", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "finished output" }] } },
		{ type: "irc_message", message: { customType: "irc:incoming", content: "IRC hello", display: true, details: { id: "irc-1" } } },
		{ type: "plan_review_requested", reviewId: "review-1", title: "Plan" },
		{ type: "plan_review_resolved", reviewId: "review-1", choice: "execute" },
	]) events.handle({ id: "agent", event });
	let output = "";
	let notify: (() => void) | undefined;
	const terminal = new Bun.Terminal({
		cols: 100, rows: 30,
		data(_terminal, data) { output += new TextDecoder().decode(data); notify?.(); },
	});
	const child = Bun.spawn([Bun.which("bun")!, fileURLToPath(new URL("../src/viewer.ts", import.meta.url)),
		session, "--socket", bridge.socketPath, "--token", token], { terminal, env: viewerEnv, timeout: 8000 });
	const waitFor = async (needle: string) => {
		if (Bun.stripANSI(output).includes(needle)) return;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		void child.exited.then(code => reject(new Error(`Viewer exited before ${needle} (${code})`)));
		notify = () => { if (Bun.stripANSI(output).includes(needle)) resolve(); };
		try { await promise; } finally { notify = undefined; }
	};
	try {
		await waitFor("PLAN REVIEW · resolved");
		terminal.write("T");
		await waitFor("finished output");
		const screen = Bun.stripANSI(output);
		expect(screen).toContain("EVENT tool_approval_requested");
		expect(screen).toContain("EVENT tool_execution_end");
		expect(screen).toContain("INPUT · IRC");
		expect(screen).toContain("IRC hello");
		expect(screen).toContain("PLAN REVIEW · resolved");
	} finally {
		child.kill();
		terminal.close();
		await child.exited;
		events.close();
		await bridge.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 10000);

test("shows outgoing IRC immediately and keeps failed delivery details behind tool controls", async () => {
	const dir = await mkdtemp(join(tmpdir(), "viewer-irc-output-"));
	const session = join(dir, "session.jsonl");
	await writeFile(session, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [
		{ type: "toolCall", id: "send", name: "write", arguments: { path: "agent://Main", content: "IRC body" } },
	] } })}\n`);
	const bridge = new LiveBridge(() => {});
	await bridge.ready;
	const token = bridge.register("agent");
	const events = new LiveEvents(bridge);
	let output = "";
	let notify: (() => void) | undefined;
	const terminal = new Bun.Terminal({
		cols: 100, rows: 30,
		data(_terminal, data) { output += new TextDecoder().decode(data); notify?.(); },
	});
	const child = Bun.spawn([Bun.which("bun")!, fileURLToPath(new URL("../src/viewer.ts", import.meta.url)),
		session, "--socket", bridge.socketPath, "--token", token], { terminal, env: viewerEnv, timeout: 8000 });
	const waitFor = async (needle: string) => {
		if (Bun.stripANSI(output).includes(needle)) return;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		void child.exited.then(code => reject(new Error(`Viewer exited before ${needle} (${code})`)));
		notify = () => { if (Bun.stripANSI(output).includes(needle)) resolve(); };
		try { await promise; } finally { notify = undefined; }
	};
	try {
		await waitFor("OUTPUT · IRC → Main · pending");
		events.handle({ id: "agent", event: {
			type: "tool_execution_start", toolCallId: "send", args: { path: "agent://Main", content: "IRC body" },
		} });
		events.handle({ id: "agent", event: {
			type: "tool_execution_end", toolCallId: "send", isError: true, result: { content: [{ type: "text", text: "Delivery denied" }] },
		} });
		await waitFor("OUTPUT · IRC → Main · error");
		terminal.write("T");
		await waitFor("Delivery denied");
		const screen = Bun.stripANSI(output.split("\x1b[H").at(-1) ?? "");
		expect(screen).toContain("EVENT tool_execution_start");
		expect(screen).toContain("EVENT tool_execution_end");
		expect(screen).not.toContain("OUTPUT · IRC → Main · ok");
		expect(screen.split("IRC body")).toHaveLength(2);
	} finally {
		child.kill();
		terminal.close();
		await child.exited;
		events.close();
		await bridge.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 10000);

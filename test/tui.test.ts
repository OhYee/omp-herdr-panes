import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveBridge } from "../src/live-bridge.ts";
import { LiveEvents } from "../src/live-events.ts";

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
	const child = Bun.spawn([bun, fileURLToPath(new URL("../src/viewer.ts", import.meta.url)), session], { terminal, timeout: 8000 });
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
		session, "--socket", bridge.socketPath, "--token", token], { terminal, timeout: 8000 });
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

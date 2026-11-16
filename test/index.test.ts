import { expect, test } from "bun:test";

// A real subprocess deadline is required to detect an extension that keeps the event loop alive.
test("extension validation exits after initialization inside Herdr", async () => {
	const bun = Bun.which("bun");
	if (!bun) throw new Error("standalone Bun is required");
	const entry = new URL("../src/index.ts", import.meta.url).href;
	const script = `
		import plugin from ${JSON.stringify(entry)};
		let registered = false;
		const pi = {
			logger: { warn() {}, error() {}, debug() {} },
			events: { on() { return () => {}; } },
			registerCommand() { registered = true; },
			on() {},
		};
		plugin(pi);
		if (!registered) throw new Error("command was not registered");
		console.log("validated");
	`;
	const child = Bun.spawn([bun, "-e", script], {
		env: { ...process.env, HERDR_PANE_ID: "test:p1", OMP_HERDR_PANES: "1" },
		stdout: "pipe",
		stderr: "pipe",
		timeout: 3000,
	});
	const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect({ status, stdout: stdout.trim(), stderr: stderr.trim() }).toEqual({ status: 0, stdout: "validated", stderr: "" });
}, 10000);

test("subagent approval hooks reach the matching viewer without affecting other sessions", async () => {
	const bun = Bun.which("bun");
	if (!bun) throw new Error("standalone Bun is required");
	const entry = new URL("../src/index.ts", import.meta.url).href;
	const bridge = new URL("../src/live-bridge.ts", import.meta.url).href;
	const panes = new URL("../src/pane-manager.ts", import.meta.url).href;
	const script = `
		import { mock } from "bun:test";
		const frames = [];
		mock.module(${JSON.stringify(bridge)}, () => ({
			LiveBridge: class {
				socketPath = "/unused";
				register() { return "token"; }
				publish(id, frame) { frames.push({ id, frame }); }
				finish() {}
				async close() {}
			},
		}));
		mock.module(${JSON.stringify(panes)}, () => ({
			PaneManager: class {
				open() {}
				has() { return false; }
				finish() {}
				async closeAll() {}
			},
		}));
		// Import after mock registration to exercise the production wiring in isolation.
		const { default: plugin } = await import(${JSON.stringify(entry)});
		const events = new Map();
		const hooks = new Map();
		plugin({
			logger: { warn() {}, error() {}, debug() {} },
			events: { on(name, callback) { events.set(name, callback); return () => {}; } },
			registerCommand() {},
			on(name, callback) { hooks.set(name, callback); },
		});
		const lifecycle = events.get("task:subagent:lifecycle");
		lifecycle({ id: "child", agent: "task", status: "started", sessionFile: "/child.jsonl" });
		const requested = hooks.get("tool_approval_requested");
		const ctx = file => ({ sessionManager: { getSessionFile: () => file } });
		requested({ type: "tool_approval_requested", toolName: "bash" }, ctx("/child.jsonl"));
		requested({ type: "tool_approval_requested", toolName: "ignored" }, ctx("/other.jsonl"));
		const approvals = frames.filter(item => item.frame.type === "event");
		if (approvals.length !== 1 || approvals[0].id !== "child" || !approvals[0].frame.text.includes("bash")) throw new Error("approval routing failed");
		lifecycle({ id: "child", agent: "task", status: "completed", sessionFile: "/child.jsonl" });
		requested({ type: "tool_approval_requested", toolName: "late" }, ctx("/child.jsonl"));
		if (frames.filter(item => item.frame.type === "event").length !== 1) throw new Error("finished session retained approval routing");
		await hooks.get("session_shutdown")();
		console.log("approval routing verified");
	`;
	const child = Bun.spawn([bun, "-e", script], {
		env: { ...process.env, HERDR_PANE_ID: "test:p1", OMP_HERDR_PANES: "1" },
		stdout: "pipe", stderr: "pipe", timeout: 3000,
	});
	const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect({ status, stdout: stdout.trim(), stderr: stderr.trim() }).toEqual({ status: 0, stdout: "approval routing verified", stderr: "" });
}, 10000);

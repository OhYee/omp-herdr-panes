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

test("plugin discovers delayed nested sessions once and launches only managed viewers", async () => {
	const bun = Bun.which("bun");
	if (!bun) throw new Error("standalone Bun is required");
	const entry = new URL("../src/index.ts", import.meta.url).href;
	const herdr = new URL("../src/herdr.ts", import.meta.url).href;
	const script = `
		import { mock } from "bun:test";
		import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		const dir = mkdtempSync(join(tmpdir(), "omp-plugin-tree-"));
		const root = join(dir, "root.jsonl");
		const outer = join(dir, "root", "Outer.jsonl");
		const inner = join(dir, "root", "Outer", "Inner.jsonl");
		const present = new Set(["w1:p1"]);
		const splits = [];
		const runs = [];
		let next = 2;
		mock.module(${JSON.stringify(herdr)}, () => ({
			HerdrError: class HerdrError extends Error {},
			createHerdrCli: () => ({
				async split(target, direction) {
					const pane = "w1:p" + next++;
					splits.push({ target, direction, pane });
					present.add(pane);
					return pane;
				},
				async run(pane, command) { runs.push({ pane, command }); },
				async rename() {},
				async close(pane) { present.delete(pane); },
				async layout() { return [...present].map(paneId => ({ paneId, rect: { x: 0, y: 0, width: 80, height: 30 } })); },
			}),
		}));
		try {
			// Import after the backend mock to exercise the extension's module boundary.
			const { default: plugin } = await import(${JSON.stringify(entry)});
			const events = new Map();
			const hooks = new Map();
			plugin({
				logger: { warn() {}, error() {}, debug() {} },
				events: { on(name, callback) { events.set(name, callback); return () => {}; } },
				registerCommand() {},
				on(name, callback) { hooks.set(name, callback); },
			});
			hooks.get("session_start")({}, { sessionManager: { getSessionFile: () => root } });
			const lifecycle = events.get("task:subagent:lifecycle");
			const started = (id, sessionFile) => lifecycle({ id, agent: "task", status: "started", sessionFile });
			started("inner-id", inner);
			started("outer-id", outer);
			started("outer-id", outer);
			mkdirSync(join(dir, "root", "Outer"), { recursive: true });
			writeFileSync(root, JSON.stringify({ type: "session", id: "root" }) + "\\n");
			writeFileSync(outer, JSON.stringify({ type: "session", id: "outer", parentSession: root }) + "\\n");
			writeFileSync(inner, JSON.stringify({ type: "session", id: "inner", parentSession: outer }) + "\\n");
			// Real time is required here to exercise the late-file polling fallback and its next scan.
			const deadline = Date.now() + 4000;
			while (runs.length < 2 && Date.now() < deadline) await Bun.sleep(25);
			await Bun.sleep(1100);
			if (JSON.stringify(splits.map(({target, direction}) => [target, direction])) !== JSON.stringify([["w1:p1", "right"], ["w1:p2", "right"]])) throw new Error("wrong recursive split targets: " + JSON.stringify(splits));
			if (runs.length !== 2 || runs.some(run => !run.command.includes(" --managed"))) throw new Error("duplicate or unmanaged viewer");
			await hooks.get("session_shutdown")();
			console.log("recursive plugin verified");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	`;
	const child = Bun.spawn([bun, "-e", script], {
		env: { ...process.env, TMUX: "", TMUX_PANE: "", TERN_PANE: "", HERDR_PANE_ID: "w1:p1", OMP_HERDR_PANES: "1", OMP_HERDR_PANES_MAX: "6" },
		stdout: "pipe", stderr: "pipe", timeout: 8000,
	});
	const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect({ status, stdout: stdout.trim(), stderr: stderr.trim() }).toEqual({ status: 0, stdout: "recursive plugin verified", stderr: "" });
}, 12000);

test("plugin retries active sessions after enabling and a split failure without opening resumed history", async () => {
	const bun = Bun.which("bun");
	if (!bun) throw new Error("standalone Bun is required");
	const entry = new URL("../src/index.ts", import.meta.url).href;
	const herdr = new URL("../src/herdr.ts", import.meta.url).href;
	const bridge = new URL("../src/live-bridge.ts", import.meta.url).href;
	const script = `
		import { mock } from "bun:test";
		import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		const dir = mkdtempSync(join(tmpdir(), "omp-plugin-retry-"));
		const root = join(dir, "root.jsonl");
		const active = join(dir, "root", "active.jsonl");
		const nested = join(dir, "root", "active", "nested.jsonl");
		const finished = join(dir, "root", "finished.jsonl");
		const late = join(dir, "root", "late.jsonl");
		const present = new Set(["w1:p1"]);
		const runs = [], splits = [], associations = [], frames = [], finishes = [];
		let next = 2, failNext = true;
		const save = (file, parent) => writeFileSync(file, JSON.stringify({ type: "session", id: file, parentSession: parent }) + "\\n");
		mock.module(${JSON.stringify(herdr)}, () => ({
			HerdrError: class HerdrError extends Error {},
			createHerdrCli: () => ({
				async split(target, direction) {
					splits.push([target, direction]);
					if (failNext) { failNext = false; throw new Error("temporary split failure"); }
					const pane = "w1:p" + next++;
					present.add(pane);
					return pane;
				},
				async run(pane, command) { runs.push({ pane, command }); },
				async rename() {},
				async close(pane) { present.delete(pane); },
				async layout() { return [...present].map(paneId => ({ paneId, rect: { x: 0, y: 0, width: 80, height: 40 } })); },
			}),
		}));
		mock.module(${JSON.stringify(bridge)}, () => ({
			LiveBridge: class {
				socketPath = "/unused";
				register() { return "token"; }
				associate(id, file) { associations.push([id, file]); }
				publish(id, frame) { frames.push({ id, frame }); }
				finish(id) { finishes.push(id); }
				async close() {}
			},
		}));
		try {
			mkdirSync(join(dir, "root", "active"), { recursive: true });
			save(root, null);
			save(join(dir, "branch.jsonl"), root);
			for (let i = 0; i < 7; i++) save(join(dir, "root", "historical-" + i + ".jsonl"), root);
			save(active, root); save(nested, active); save(finished, root);
			// Import after backend mocks to exercise the actual extension boundary.
			const { default: plugin } = await import(${JSON.stringify(entry)});
			const events = new Map(), hooks = new Map();
			let command;
			plugin({
				logger: { warn() {}, error() {}, debug() {} },
				events: { on(name, callback) { events.set(name, callback); return () => {}; } },
				registerCommand(_name, options) { command = options.handler; },
				on(name, callback) { hooks.set(name, callback); },
			});
			hooks.get("session_start")({}, { sessionManager: { getSessionFile: () => root } });
			const lifecycle = events.get("task:subagent:lifecycle");
			const event = (id, status, sessionFile) => lifecycle({ id, agent: "task", status, sessionFile });
			event("active-id", "started", active);
			event("nested-id", "started", nested);
			event("finished-id", "started", finished);
			event("finished-id", "completed", finished);
			// Real time exercises the scan retry after a terminal failure.
			await Bun.sleep(75);
			if (splits.length) throw new Error("opened while disabled");
			command("enabled", { ui: { notify() {} } });
			const deadline = Date.now() + 4000;
			while (runs.length < 2 && Date.now() < deadline) await Bun.sleep(25);
			if (JSON.stringify(splits) !== JSON.stringify([["w1:p1", "right"], ["w1:p1", "right"], ["w1:p2", "right"]])) throw new Error("incorrect retry or split targets: " + JSON.stringify(splits));
			if (runs.length !== 2 || runs.some(run => !run.command.includes(" --managed"))) throw new Error("historical, finished or duplicate pane opened");
			if (!associations.some(([id, file]) => id === "active-id" && file === active) || !associations.some(([id, file]) => id === "nested-id" && file === nested)) throw new Error("resumed live stream was not associated");
			hooks.get("tool_approval_requested")({ type: "tool_approval_requested", toolName: "bash" }, { sessionManager: { getSessionFile: () => active } });
			if (!frames.some(item => item.id === "active-id" && item.frame.type === "event" && item.frame.text.includes("bash"))) throw new Error("approval did not reach resumed viewer");
			event("active-id", "completed", active);
			event("late-id", "started", late);
			event("late-id", "completed", late);
			save(late, root);
			const lateDeadline = Date.now() + 4000;
			while (runs.length < 3 && Date.now() < lateDeadline) await Bun.sleep(25);
			await Bun.sleep(1100);
			if (runs.length !== 3 || !runs[2].command.includes("late.jsonl")) throw new Error("completed task with late transcript did not open");
			if (associations.filter(([id, file]) => id === "late-id" && file === late).length < 2) throw new Error("late viewer was not re-associated");
			if (!frames.some(item => item.id === "active-id" && item.frame.type === "state" && item.frame.status === "completed") || frames.filter(item => item.id === "late-id" && item.frame.type === "state" && item.frame.status === "completed").length < 2) throw new Error("completed state was not delivered");
			if (!finishes.includes("active-id") || !finishes.includes("late-id")) throw new Error("live channels were not finished");
			await hooks.get("session_shutdown")();
			console.log("active retry verified");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	`;
	const child = Bun.spawn([bun, "-e", script], {
		env: { ...process.env, TMUX: "", TMUX_PANE: "", TERN_PANE: "", HERDR_PANE_ID: "w1:p1", OMP_HERDR_PANES: "0", OMP_HERDR_PANES_MAX: "6", OMP_HERDR_PANES_AUTO_CLOSE: "0" },
		stdout: "pipe", stderr: "pipe", timeout: 8000,
	});
	const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect({ status, stdout: stdout.trim(), stderr: stderr.trim() }).toEqual({ status: 0, stdout: "active retry verified", stderr: "" });
}, 12000);

test("finished queued tasks, including late transcripts, do not take a later active task's pane", async () => {
	const bun = Bun.which("bun");
	if (!bun) throw new Error("standalone Bun is required");
	const entry = new URL("../src/index.ts", import.meta.url).href;
	const herdr = new URL("../src/herdr.ts", import.meta.url).href;
	const bridge = new URL("../src/live-bridge.ts", import.meta.url).href;
	const script = `
		import { mock } from "bun:test";
		import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		const dir = mkdtempSync(join(tmpdir(), "omp-plugin-queue-"));
		const root = join(dir, "root.jsonl");
		const a = join(dir, "root", "A.jsonl"), b = join(dir, "root", "B.jsonl"), c = join(dir, "root", "C.jsonl");
		const d = join(dir, "root", "D.jsonl"), e = join(dir, "root", "E.jsonl");
		const present = new Set(["w1:p1"]), queued = new Set(), queueCounts = new Map(), runs = [];
		let next = 2;
		mock.module(${JSON.stringify(herdr)}, () => ({
			HerdrError: class HerdrError extends Error {},
			createHerdrCli: () => ({
				async split() { const pane = "w1:p" + next++; present.add(pane); return pane; },
				async run(pane, command) { runs.push({ pane, command }); },
				async rename() {},
				async close(pane) { present.delete(pane); },
				async layout() { return [...present].map(paneId => ({ paneId, rect: { x: 0, y: 0, width: 80, height: 40 } })); },
			}),
		}));
		mock.module(${JSON.stringify(bridge)}, () => ({
			LiveBridge: class {
				socketPath = "/unused";
				register() { return "token"; }
				associate() {}
				publish() {}
				finish() {}
				async close() {}
			},
		}));
		try {
			mkdirSync(join(dir, "root"));
			writeFileSync(root, JSON.stringify({ type: "session", id: "root" }) + "\\n");
			for (const file of [a, b, c, e]) writeFileSync(file, JSON.stringify({ type: "session", id: file, parentSession: root }) + "\\n");
			// Import after backend mocks to exercise the extension's real queue and scanner.
			const { default: plugin } = await import(${JSON.stringify(entry)});
			const events = new Map(), hooks = new Map();
			plugin({
				logger: { warn(message, context) { if (message.includes("pane limit reached")) { queued.add(context.key); queueCounts.set(context.key, (queueCounts.get(context.key) ?? 0) + 1); } }, error() {}, debug() {} },
				events: { on(name, callback) { events.set(name, callback); return () => {}; } },
				registerCommand() {},
				on(name, callback) { hooks.set(name, callback); },
			});
			hooks.get("session_start")({}, { sessionManager: { getSessionFile: () => root } });
			const lifecycle = events.get("task:subagent:lifecycle");
			const event = (id, status, sessionFile) => lifecycle({ id, agent: "task", status, sessionFile });
			// Real time lets the scanner and terminal reconciliation run as they do in the consumer.
			const until = async (predicate) => {
				const deadline = Date.now() + 4000;
				while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
				if (!predicate()) throw new Error("timed out waiting for pane state");
			};
			event("A", "started", a);
			await until(() => runs.length === 1);
			event("B", "started", b);
			await until(() => queued.has(b));
			event("B", "completed", b);
			await Bun.sleep(1100);
			event("C", "started", c);
			await until(() => queued.has(c));
			present.delete("w1:p2");
			await until(() => runs.length === 2);
			if (!runs[0].command.includes("A.jsonl") || !runs[1].command.includes("C.jsonl")) throw new Error("finished queued task consumed the free pane: " + JSON.stringify(runs));
			event("D", "started", d);
			event("D", "completed", d);
			writeFileSync(d, JSON.stringify({ type: "session", id: d, parentSession: root }) + "\\n");
			await until(() => queued.has(d));
			await Bun.sleep(1100);
			if (queueCounts.get(d) !== 1) throw new Error("late completed task was requeued");
			event("E", "started", e);
			await until(() => queued.has(e));
			present.delete("w1:p3");
			await until(() => runs.length === 3);
			if (!runs[2].command.includes("E.jsonl") || runs.some(run => run.command.includes("D.jsonl"))) throw new Error("late completed task consumed the free pane: " + JSON.stringify(runs));
			await hooks.get("session_shutdown")();
			console.log("queue lifecycle verified");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	`;
	const child = Bun.spawn([bun, "-e", script], {
		env: { ...process.env, TMUX: "", TMUX_PANE: "", TERN_PANE: "", HERDR_PANE_ID: "w1:p1", OMP_HERDR_PANES: "1", OMP_HERDR_PANES_MAX: "1", OMP_HERDR_PANES_AUTO_CLOSE: "0" },
		stdout: "pipe", stderr: "pipe", timeout: 15000,
	});
	const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect({ status, stdout: stdout.trim(), stderr: stderr.trim() }).toEqual({ status: 0, stdout: "queue lifecycle verified", stderr: "" });
}, 20000);

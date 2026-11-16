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

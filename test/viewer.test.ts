import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tmux = Bun.which("tmux");
const bun = Bun.which("bun");

test.skipIf(!tmux || !bun)("managed viewers close only their own panes when their owner dies", async () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-viewer-orphan-"));
	const socket = join(dir, "tmux.sock");
	const root = join(dir, "root.jsonl");
	const parent = join(dir, "root", "A.jsonl");
	const child = join(dir, "root", "A", "A1.jsonl");
	const viewer = fileURLToPath(new URL("../src/viewer.ts", import.meta.url));
	const env = { ...process.env, TMUX: "", TMUX_PANE: "", HERDR_PANE_ID: "", TERN_PANE: "" };
	const call = async (...args: string[]): Promise<string> => {
		const proc = Bun.spawn([tmux!, "-S", socket, ...args], { env, stdout: "pipe", stderr: "pipe" });
		const [status, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		if (status !== 0) throw new Error(`tmux ${args[0]} failed: ${stderr}`);
		return stdout.trim();
	};
	const list = async () => (await call("list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}\t#{pane_title}"))
		.split("\n").map((line) => {
			const [id, pid, dead, command, title] = line.split("\t");
			return { id, pid, dead, command, title };
		});
	try {
		mkdirSync(join(dir, "root", "A"), { recursive: true });
		writeFileSync(root, `${JSON.stringify({ type: "session", id: "root" })}\n`);
		writeFileSync(parent, `${JSON.stringify({ type: "session", id: "A", parentSession: root })}\n`);
		writeFileSync(child, `${JSON.stringify({ type: "session", id: "A1", parentSession: parent })}\n`);
		const rootPane = await call("new-session", "-d", "-s", "orphan", "-x", "240", "-y", "80",
			"-e", "OMP_HERDR_PANES=1", "-e", "OMP_HERDR_PANES_AUTO_CLOSE=0",
			"-P", "-F", "#{pane_id}", bun!, viewer, root);
		await call("set-option", "-w", "-t", rootPane, "remain-on-exit", "on");
		// A real terminal and the viewer's parent watchdog require platform-clock polling.
		let panes = await list();
		const openDeadline = Date.now() + 6000;
		const viewersReady = () => ["A", "A1"].every((title) => panes.some((pane) =>
			pane.id !== rootPane && pane.title === title && /^bun(?:\.exe)?$/u.test(pane.command ?? "")));
		while (!viewersReady() && Date.now() < openDeadline) { await Bun.sleep(50); panes = await list(); }
		expect(panes.map((pane) => pane.title)).toEqual(expect.arrayContaining(["A", "A1"]));
		expect(viewersReady()).toBe(true);
		const owner = panes.find((pane) => pane.id === rootPane);
		expect(owner?.command).toMatch(/^bun(?:\.exe)?$/u);
		const ownerPid = Number(owner?.pid);
		expect(Number.isSafeInteger(ownerPid) && ownerPid > 0).toBe(true);
		process.kill(ownerPid, "SIGKILL");
		const closeDeadline = Date.now() + 6000;
		while (panes.length > 1 && Date.now() < closeDeadline) { await Bun.sleep(50); panes = await list(); }
		expect(panes.map((pane) => pane.id)).toEqual([rootPane]);
		expect(panes[0]?.dead).toBe("1");

		// A mismatching claimed pane id must never close the actual user pane.
		await call("respawn-pane", "-k", "-t", rootPane, bun!, viewer, root,
			"--managed", "--pane-id", "%999", "--parent-pid", String(ownerPid));
		const mismatchDeadline = Date.now() + 6000;
		panes = await list();
		while (panes[0]?.dead !== "1" && Date.now() < mismatchDeadline) { await Bun.sleep(50); panes = await list(); }
		expect(panes.map((pane) => pane.id)).toEqual([rootPane]);
		expect(panes[0]?.dead).toBe("1");
	} finally {
		const stop = Bun.spawn([tmux!, "-S", socket, "kill-server"], { env, stdout: "ignore", stderr: "ignore" });
		await stop.exited;
		rmSync(dir, { recursive: true, force: true });
	}
}, 23000);

test.skipIf(!tmux || !bun)("a late root sibling does not move an existing grandchild outside its parent row", async () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-viewer-geometry-"));
	const socket = join(dir, "tmux.sock");
	const root = join(dir, "root.jsonl"), a = join(dir, "root", "A.jsonl");
	const viewer = fileURLToPath(new URL("../src/viewer.ts", import.meta.url));
	const env = { ...process.env, TMUX: "", TMUX_PANE: "", HERDR_PANE_ID: "", TERN_PANE: "" };
	const call = async (...args: string[]): Promise<string> => {
		const proc = Bun.spawn([tmux!, "-S", socket, ...args], { env, stdout: "pipe", stderr: "pipe" });
		const [status, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		if (status !== 0) throw new Error(`tmux ${args[0]} failed: ${stderr}`);
		return stdout.trim();
	};
	const list = async () => (await call("list-panes", "-a", "-F", "#{pane_title}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}"))
		.split("\n").map((line) => {
			const [title, left, top, width, height] = line.split("\t");
			return { title, left: Number(left), top: Number(top), width: Number(width), height: Number(height) };
		});
	// File discovery and pane creation cross a real terminal process, so wait on observable titles.
	const waitFor = async (title: string) => {
		const deadline = Date.now() + 6000;
		let panes = await list();
		while (!panes.some((pane) => pane.title === title) && Date.now() < deadline) { await Bun.sleep(50); panes = await list(); }
		expect(panes.some((pane) => pane.title === title)).toBe(true);
		return panes;
	};
	const save = (file: string, parent: string) => writeFileSync(file, `${JSON.stringify({ type: "session", id: file, parentSession: parent })}\n`);
	try {
		mkdirSync(join(dir, "root", "A"), { recursive: true });
		writeFileSync(root, `${JSON.stringify({ type: "session", id: "root" })}\n`);
		save(join(dir, "branch.jsonl"), root);
		await call("new-session", "-d", "-s", "geometry", "-x", "240", "-y", "80",
			"-e", "OMP_HERDR_PANES=1", "-e", "OMP_HERDR_PANES_AUTO_CLOSE=0", "-e", "OMP_HERDR_PANES_MAX=8",
			bun!, viewer, root);
		save(a, root); await waitFor("A");
		save(join(dir, "root", "A", "A1.jsonl"), a); await waitFor("A1");
		save(join(dir, "root", "A", "A2.jsonl"), a); await waitFor("A2");
		save(join(dir, "root", "B.jsonl"), root);
		const panes = await waitFor("B");
		expect(panes.some((pane) => pane.title === "branch")).toBe(false);
		expect(panes).toHaveLength(5);
		const parent = panes.find((pane) => pane.title === "A")!;
		const child = panes.find((pane) => pane.title === "A2")!;
		expect(child.left).toBeGreaterThan(parent.left);
		expect(child.top).toBeLessThan(parent.top + parent.height);
		expect(parent.top).toBeLessThan(child.top + child.height);
	} finally {
		const stop = Bun.spawn([tmux!, "-S", socket, "kill-server"], { env, stdout: "ignore", stderr: "ignore" });
		await stop.exited;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30000);

test.skipIf(!bun)("non-interactive viewer associates outgoing IRC with its persisted failure", async () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-viewer-irc-"));
	const session = join(dir, "session.jsonl");
	const entries = [
		{ type: "message", message: { role: "assistant", content: [
			{ type: "toolCall", id: "send", name: "write", arguments: { path: "agent://Main?progress", content: "progress body" } },
		] } },
		{ type: "custom", customType: "tool_execution_start", data: { toolCallId: "send", args: { path: "agent://Main?progress" } } },
		{ type: "message", message: { role: "toolResult", toolCallId: "send", toolName: "write", isError: true, content: "delivery failed" } },
	];
	writeFileSync(session, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	const viewer = fileURLToPath(new URL("../src/viewer.ts", import.meta.url));
	const child = Bun.spawn([bun!, viewer, session], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 8000 });
	const reader = child.stdout.getReader();
	let output = "";
	try {
		while (!output.includes("delivery failed")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("Viewer exited before the IRC receipt");
			output += new TextDecoder().decode(chunk.value);
		}
		const text = Bun.stripANSI(output);
		expect(text).toContain("OUTPUT · IRC progress → Main");
		expect(text).toContain("IRC progress → Main · tool_execution_start");
		expect(text).toContain("✗ IRC progress → Main");
		expect(text.split("progress body")).toHaveLength(2);
		expect(text).not.toContain("✓ IRC progress → Main");
	} finally {
		child.kill();
		await child.exited;
		await reader.cancel();
		rmSync(dir, { recursive: true, force: true });
	}
}, 10000);

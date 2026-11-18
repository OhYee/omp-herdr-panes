import { expect, test } from "bun:test";
import { once } from "node:events";
import { existsSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname } from "node:path";
import { LiveBridge } from "../src/live-bridge.ts";

async function connect(bridge: LiveBridge, handshake: string): Promise<Socket> {
	await bridge.ready;
	const socket = createConnection(bridge.socketPath);
	await once(socket, "connect");
	socket.write(handshake);
	return socket;
}

function readLine(socket: Socket): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let data = "";
	const onData = (chunk: Buffer) => {
		data += chunk.toString("utf8");
		const end = data.indexOf("\n");
		if (end < 0) return;
		socket.off("data", onData);
		socket.off("error", reject);
		resolve(JSON.parse(data.slice(0, end)));
	};
	socket.on("data", onData);
	socket.once("error", reject);
	return promise;
}

function hello(token: string): string {
	return `${JSON.stringify({ token })}\n`;
}

test("authorizes tokens, rejects malformed and oversized handshakes, and keeps secrets out of logs", async () => {
	const logs: string[] = [];
	const bridge = new LiveBridge((message, context) => logs.push(message + JSON.stringify(context)));
	try {
		const token = bridge.register("a");
		expect(token).toHaveLength(64);
		for (const input of [hello("wrong"), "not-json\n", `${"x".repeat(1025)}\n`, '{"token":5}\n']) {
			const socket = await connect(bridge, input);
			await once(socket, "close");
		}
		expect(logs.join(" ")).not.toContain(token);
		expect(statSync(dirname(bridge.socketPath)).mode & 0o777).toBe(0o700);
	} finally {
		await bridge.close();
	}
});

test("replays only the latest live snapshot and clears it", async () => {
	const bridge = new LiveBridge(() => {});
	try {
		const token = bridge.register("a");
		bridge.publish("a", { type: "live", value: 1 });
		bridge.publish("a", { type: "live", value: 2 });
		const first = await connect(bridge, hello(token));
		expect(await readLine(first)).toEqual({ type: "live", value: 2 });
		bridge.publish("a", { type: "clear" });
		first.destroy();
		const second = await connect(bridge, hello(token));
		expect(await readLine(second)).toEqual({ type: "ready" });
		const line = readLine(second);
		bridge.publish("a", { type: "event", value: 3 });
		expect(await line).toEqual({ type: "event", value: 3 });
		second.destroy();
	} finally {
		await bridge.close();
	}
});

test("buffers live events before the viewer connects and reports backlog overflow", async () => {
	const bridge = new LiveBridge(() => {});
	try {
		const token = bridge.register("a");
		bridge.publish("a", { type: "event", name: "first", text: "hello" });
		for (let index = 0; index < 6; index++) bridge.publish("a", { type: "event", name: `event-${index}`, text: "x".repeat(100_000) });
		const socket = await connect(bridge, hello(token));
		const { promise, resolve, reject } = Promise.withResolvers<Array<{ type: string; name?: string; text?: string }>>();
		let data = "";
		socket.on("error", reject);
		socket.on("data", (chunk: Buffer) => {
			data += chunk.toString("utf8");
			const lines = data.split("\n");
			if (lines.length >= 9) resolve(lines.slice(0, -1).map(line => JSON.parse(line)));
		});
		const frames = await promise;
		expect(frames[0]).toEqual({ type: "event", name: "first", text: "hello" });
		expect(frames.slice(1, 6).map(frame => frame.name)).toEqual(["event-0", "event-1", "event-2", "event-3", "event-4"]);
		expect(frames[6]?.name).toBe("backlog_overflow");
		expect(frames[6]?.text).toContain("1 live events");
		expect(frames[7]).toEqual({ type: "ready" });
		socket.destroy();
	} finally {
		await bridge.close();
	}
});

test("isolates each agent and broadcasts to all its viewers", async () => {
	const bridge = new LiveBridge(() => {});
	try {
		const a = bridge.register("a");
		const b = bridge.register("b");
		expect(a).not.toBe(b);
		bridge.publish("a", { type: "live", owner: "a" });
		bridge.publish("b", { type: "live", owner: "b" });
		const a1 = await connect(bridge, hello(a));
		const a2 = await connect(bridge, hello(a));
		const b1 = await connect(bridge, hello(b));
		expect(await readLine(a1)).toEqual({ type: "live", owner: "a" });
		expect(await readLine(a2)).toEqual({ type: "live", owner: "a" });
		expect(await readLine(b1)).toEqual({ type: "live", owner: "b" });
		const nextA1 = readLine(a1);
		const nextA2 = readLine(a2);
		const nextB = readLine(b1);
		bridge.publish("a", { type: "event", owner: "a" });
		bridge.publish("b", { type: "event", owner: "b" });
		expect(await nextA1).toEqual({ type: "event", owner: "a" });
		expect(await nextA2).toEqual({ type: "event", owner: "a" });
		expect(await nextB).toEqual({ type: "event", owner: "b" });
	} finally {
		await bridge.close();
	}
});

test("retains a finished agent for a late viewer and reuses its token on revival", async () => {
	const bridge = new LiveBridge(() => {});
	try {
		const token = bridge.register("a");
		bridge.publish("a", { type: "live", value: "before finish" });
		bridge.finish("a");
		expect(bridge.register("a")).toBe(token);
		bridge.finish("a");
		const socket = await connect(bridge, hello(token));
		expect(await readLine(socket)).toEqual({ type: "live", value: "before finish" });
		expect(bridge.register("a")).toBe(token);
	} finally {
		await bridge.close();
	}
});

test("retains finished agents across disconnect and reuses their token on revival", async () => {
	const bridge = new LiveBridge(() => {});
	try {
		const token = bridge.register("a");
		bridge.publish("a", { type: "live", value: "ready" });
		const socket = await connect(bridge, hello(token));
		await readLine(socket);
		bridge.finish("a");
		expect(bridge.register("a")).toBe(token);
		const line = readLine(socket);
		bridge.publish("a", { type: "event", value: "revived" });
		expect(await line).toEqual({ type: "event", value: "revived" });
		bridge.finish("a");
		const disconnected = once(socket, "close");
		socket.end();
		await disconnected;
		expect(bridge.register("a")).toBe(token);
		bridge.publish("a", { type: "live", value: "after reconnect" });
		const replacement = await connect(bridge, hello(token));
		expect(await readLine(replacement)).toEqual({ type: "live", value: "after reconnect" });
	} finally {
		await bridge.close();
	}
});

test("rejects an oversized snapshot without sending a truncated frame", async () => {
	const logs: string[] = [];
	const bridge = new LiveBridge((message) => logs.push(message));
	try {
		const token = bridge.register("a");
		bridge.publish("a", { type: "live", value: "ready" });
		const socket = await connect(bridge, hello(token));
		await readLine(socket);
		const closed = once(socket, "close");
		bridge.publish("a", { type: "live", value: "x".repeat(1024 * 1024) });
		await closed;
		expect(logs).toContain("Live bridge frame exceeded size limit");
		bridge.publish("a", { type: "live", value: "next" });
		const replacement = await connect(bridge, hello(token));
		expect(await readLine(replacement)).toEqual({ type: "live", value: "next" });
	} finally {
		await bridge.close();
	}
});

test("disconnects a slow viewer and continues serving a new one", async () => {
	const bridge = new LiveBridge(() => {});
	try {
		const token = bridge.register("a");
		bridge.publish("a", { type: "live", value: "ready" });
		const slow = await connect(bridge, hello(token));
		await readLine(slow);
		slow.pause();
		const closed = once(slow, "close");
		for (let i = 0; i < 80; i++) bridge.publish("a", { type: "event", value: "x".repeat(256 * 1024) });
		slow.resume();
		await closed;
		bridge.publish("a", { type: "live", value: "still alive" });
		const replacement = await connect(bridge, hello(token));
		expect(await readLine(replacement)).toEqual({ type: "live", value: "still alive" });
	} finally {
		await bridge.close();
	}
});

test("close removes socket directory and is safe during startup or with broken clients", async () => {
	const immediate = new LiveBridge(() => {});
	const immediateDir = dirname(immediate.socketPath);
	await Promise.all([immediate.close(), immediate.close()]);
	expect(existsSync(immediateDir)).toBe(false);

	const bridge = new LiveBridge(() => {});
	const directory = dirname(bridge.socketPath);
	const token = bridge.register("a");
	const socket = await connect(bridge, hello(token));
	socket.destroy();
	bridge.publish("a", { type: "live", value: "after disconnect" });
	await bridge.close();
	expect(existsSync(directory)).toBe(false);
	expect(() => bridge.register("a")).toThrow();
});

test("a discovered viewer keeps its token when a different lifecycle id arrives", async () => {
	const bridge = new LiveBridge(() => {});
	try {
		const first = bridge.register("/sessions/filename.jsonl");
		const other = bridge.register("/sessions/other.jsonl");
		bridge.associate("agent-name", "/sessions/filename.jsonl");
		bridge.associate("other-agent", "/sessions/other.jsonl");
		bridge.publish("agent-name", { type: "live", owner: "first" });
		bridge.publish("other-agent", { type: "live", owner: "other" });
		expect(bridge.register("/sessions/filename.jsonl")).toBe(first);
		const firstSocket = await connect(bridge, hello(first));
		const otherSocket = await connect(bridge, hello(other));
		expect(await readLine(firstSocket)).toEqual({ type: "live", owner: "first" });
		expect(await readLine(otherSocket)).toEqual({ type: "live", owner: "other" });
	} finally { await bridge.close(); }
});

test("a late viewer receives the completed lifecycle state after connecting", async () => {
	const bridge = new LiveBridge(() => {});
	try {
		const token = bridge.register("/sessions/late.jsonl");
		bridge.associate("late-agent", "/sessions/late.jsonl");
		bridge.publish("late-agent", { type: "live", content: [] });
		bridge.publish("late-agent", { type: "state", status: "completed" });
		bridge.finish("late-agent");
		await bridge.ready;
		const socket = createConnection(bridge.socketPath);
		const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
		let buffer = "";
		socket.on("error", reject);
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			if (lines.length >= 3) resolve(lines.slice(0, 2).map((line) => JSON.parse(line)));
		});
		await once(socket, "connect");
		socket.write(hello(token));
		expect(await promise).toEqual([{ type: "live", content: [] }, { type: "state", status: "completed" }]);
		socket.destroy();
	} finally { await bridge.close(); }
});

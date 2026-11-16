import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

const MAX_HANDSHAKE_BYTES = 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_BACKLOG_BYTES = 512 * 1024;
const MAX_CONNECTIONS = 64;
const HANDSHAKE_TIMEOUT_MS = 5000;
const FINISHED_TIMEOUT_MS = 5 * 60 * 1000;

type Agent = {
	token: string;
	clients: Set<Socket>;
	snapshot?: string;
	pendingEvents: string[];
	pendingEventBytes: number;
	droppedEvents: number;
	finished: boolean;
	timer?: NodeJS.Timeout;
};

export class LiveBridge {
	readonly socketPath: string;
	private readonly directory: string;
	private readonly server: Server;
	private readonly agents = new Map<string, Agent>();
	private readonly tokens = new Map<string, Agent>();
	private readonly sockets = new Set<Socket>();
	readonly ready: Promise<void>;
	private closing?: Promise<void>;
	private failed = false;

	constructor(private readonly log: (message: string, context?: Record<string, unknown>) => void) {
		try {
			this.directory = mkdtempSync("/tmp/omp-live-");
		} catch {
			this.log("Live bridge could not create private socket directory");
			throw new Error("Live bridge could not create private socket directory");
		}
		this.socketPath = join(this.directory, "socket");
		this.server = createServer((socket) => this.accept(socket));

		const { promise, resolve } = Promise.withResolvers<void>();
		this.ready = promise;
		this.server.once("listening", resolve);
		this.server.on("error", () => {
			this.failed = true;
			this.log("Live bridge socket error");
			resolve();
			void this.close();
		});
		try {
			this.server.listen(this.socketPath);
		} catch {
			this.failed = true;
			this.log("Live bridge socket error");
			resolve();
			void this.close();
		}
	}

	register(id: string): string {
		if (this.closing || this.failed) throw new Error("Live bridge is closed");
		const existing = this.agents.get(id);
		if (existing) {
			clearTimeout(existing.timer);
			existing.timer = undefined;
			existing.finished = false;
			return existing.token;
		}
		const agent: Agent = { token: randomBytes(32).toString("hex"), clients: new Set(), pendingEvents: [], pendingEventBytes: 0, droppedEvents: 0, finished: false };
		this.agents.set(id, agent);
		this.tokens.set(agent.token, agent);
		return agent.token;
	}

	publish(id: string, frame: unknown): void {
		const agent = this.agents.get(id);
		if (!agent || this.closing || this.failed) return;
		let line: string;
		try {
			const json = JSON.stringify(frame);
			if (json === undefined) throw new Error("Not JSON serializable");
			line = `${json}\n`;
		} catch {
			this.log("Live bridge could not serialize frame");
			return;
		}
		if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
			agent.snapshot = undefined;
			for (const socket of agent.clients) socket.destroy();
			this.log("Live bridge frame exceeded size limit");
			return;
		}
		if (frame !== null && typeof frame === "object" && "type" in frame) {
			if (frame.type === "live") agent.snapshot = line;
			else if (frame.type === "clear") agent.snapshot = undefined;
			else if (frame.type === "event" && "name" in frame && "text" in frame) {
				let connected = false;
				for (const socket of agent.clients) if (!socket.destroyed) { connected = true; break; }
				if (!connected) {
					const size = Buffer.byteLength(line);
					if (agent.pendingEventBytes + size <= MAX_EVENT_BACKLOG_BYTES) {
						agent.pendingEvents.push(line);
						agent.pendingEventBytes += size;
					} else agent.droppedEvents++;
				}
			}
		}
		for (const socket of agent.clients) this.send(socket, line);
	}

	finish(id: string): void {
		const agent = this.agents.get(id);
		if (!agent || agent.finished) return;
		agent.finished = true;
		if (agent.clients.size === 0) {
			agent.timer = setTimeout(() => this.release(id, agent), FINISHED_TIMEOUT_MS);
			agent.timer.unref();
		}
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closing = (async () => {
			for (const socket of this.sockets) socket.destroy();
			for (const [id, agent] of this.agents) this.release(id, agent);
			await this.ready;
			if (this.server.listening) {
				const { promise, resolve } = Promise.withResolvers<void>();
				this.server.close(() => resolve());
				await promise;
			}
			try {
				rmSync(this.directory, { recursive: true, force: true });
			} catch {
				this.log("Live bridge could not remove socket directory");
			}
		})();
		return this.closing;
	}
	private accept(socket: Socket): void {
		if (this.closing || this.sockets.size >= MAX_CONNECTIONS) {
			socket.destroy();
			return;
		}
		this.sockets.add(socket);
		let agent: Agent | undefined;
		let input = Buffer.alloc(0);
		socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			this.sockets.delete(socket);
			if (!agent) return;
			agent.clients.delete(socket);
			if (agent.finished && agent.clients.size === 0) {
				for (const [id, candidate] of this.agents) {
					if (candidate !== agent) continue;
					const retained = agent;
					clearTimeout(retained.timer);
					retained.timer = setTimeout(() => this.release(id, retained), FINISHED_TIMEOUT_MS);
					retained.timer.unref();
				}
			}
		});
		socket.on("data", (chunk: Buffer) => {
			if (agent || input.length + chunk.length > MAX_HANDSHAKE_BYTES) {
				socket.destroy();
				return;
			}
			input = Buffer.concat([input, chunk]);
			const newline = input.indexOf(10);
			if (newline < 0) return;
			if (newline !== input.length - 1) {
				socket.destroy();
				return;
			}
			try {
				const hello: unknown = JSON.parse(input.subarray(0, newline).toString("utf8"));
				if (hello && typeof hello === "object" && "token" in hello && typeof hello.token === "string") {
					agent = this.tokens.get(hello.token);
				}
			} catch {
				// Invalid handshakes are rejected without logging their contents.
			}
			if (!agent) {
				socket.destroy();
				return;
			}
			socket.setTimeout(0);
			clearTimeout(agent.timer);
			agent.timer = undefined;
			agent.clients.add(socket);
			for (const line of agent.pendingEvents) this.send(socket, line);
			agent.pendingEvents = [];
			agent.pendingEventBytes = 0;
			if (agent.droppedEvents) {
				this.send(socket, `${JSON.stringify({ type: "event", name: "backlog_overflow", text: `${agent.droppedEvents} live events could not be retained before the viewer connected.` })}\n`);
				agent.droppedEvents = 0;
			}
			if (agent.snapshot) this.send(socket, agent.snapshot);
			else this.send(socket, '{"type":"ready"}\n');
		});
	}

	private send(socket: Socket, line: string): void {
		if (socket.destroyed) return;
		if (socket.writableLength + Buffer.byteLength(line) > MAX_PENDING_BYTES) {
			socket.destroy();
			return;
		}
		socket.write(line);
	}

	private release(id: string, agent: Agent): void {
		clearTimeout(agent.timer);
		for (const socket of agent.clients) socket.destroy();
		this.agents.delete(id);
		this.tokens.delete(agent.token);
	}
}

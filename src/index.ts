/**
 * Oh My Pi extension entry: route lifecycle events and session trees to terminal panes.
 *
 * OMP loads the extension for child sessions too. One process-wide manager owns every pane, and
 * one subscription per event bus avoids duplicate handling when sessions share a bus.
 *
 * Outside a supported terminal the config is `null` and the factory returns without registering anything.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { completePaneCommand, handlePaneCommand, type PaneSettings } from "./command.ts";
import { parseLifecycle, readConfig, shellQuote } from "./config.ts";
import { createHerdrCli } from "./herdr.ts";
import { detectPaneContext, createTernBackend, createTmuxBackend, type PaneBackend } from "./terminal-backend.ts";
import { LiveBridge } from "./live-bridge.ts";
import { LiveEvents } from "./live-events.ts";
import type { ExtensionAPI, OmpEventBus } from "./omp-types.ts";
import { PaneManager } from "./pane-manager.ts";
import { SessionTree } from "./session-tree.ts";

/** `src/viewer.ts` next to this module; resolved from this file so any install path works. */
const VIEWER_PATH = fileURLToPath(new URL("./viewer.ts", import.meta.url));

/** One `PaneManager` per process, shared by the parent session and every child session. */
let manager: PaneManager | undefined;
let bridge: LiveBridge | undefined;
let liveEvents: LiveEvents | undefined;
let settings: PaneSettings | undefined;
let tree: SessionTree | undefined;
const pendingSessions = new Map<string, { label: string; status?: string; finishedAt?: number; openIfFinished?: boolean }>();
const viewerTokens = new Map<string, { token: string; timer?: NodeJS.Timeout }>();
const sessionAgents = new Map<string, { id: string; status?: string }>();
/** True once some factory call in this process claimed ownership (the first one is the parent). */
let ownerClaimed = false;
/** Unsubscribe function per event bus that already carries our lifecycle listener. */
const subscriptions = new Map<OmpEventBus, () => void>();

function channelFor(file: string, pi: ExtensionAPI): string | undefined {
	try {
		if (!bridge) {
			bridge = new LiveBridge((message, context) => pi.logger.warn(`herdr-panes: ${message}`, context));
			liveEvents = new LiveEvents(bridge);
		}
		const existing = viewerTokens.get(file);
		if (existing) return existing.token;
		const token = bridge.register(file);
		viewerTokens.set(file, { token });
		return token;
	} catch (error) {
		pi.logger.warn("herdr-panes: live streaming unavailable", { error: String(error) });
		return undefined;
	}
}

function expireChannel(file: string): void {
	const channel = viewerTokens.get(file);
	if (!channel) return;
	clearTimeout(channel.timer);
	channel.timer = setTimeout(() => {
		if (viewerTokens.get(file) === channel) viewerTokens.delete(file);
	}, 5 * 60 * 1000);
	channel.timer.unref();
}

export default function ompHerdrPanes(pi: ExtensionAPI): void {
	const paneContext = detectPaneContext(process.env);
	const config = readConfig(process.env, true);
	if (config === null || paneContext === null) return;

	const bun = Bun.which("bun");
	if (!bun) {
		pi.logger.warn("herdr-panes: standalone Bun is required to run viewer panes");
		return;
	}

	let backend: PaneBackend;
	try {
		if (paneContext.backend === "herdr") {
			backend = createHerdrCli();
		} else if (paneContext.backend === "tern") {
			backend = createTernBackend(config.mainPaneId);
		} else if (paneContext.backend === "tmux") {
			backend = createTmuxBackend(config.mainPaneId, paneContext.tmuxEnv);
		} else {
			return;
		}
	} catch (error) {
		pi.logger.warn("herdr-panes: terminal pane backend unavailable", { backend: paneContext.backend, error: String(error) });
		return;
	}
	const isOwner = !ownerClaimed;
	ownerClaimed = true;
	settings ??= { enabled: process.env.OMP_HERDR_PANES !== "0", autoClose: config.autoClose, closeDelayMs: config.closeDelayMs, failCloseDelayMs: config.failCloseDelayMs };

	manager ??= new PaneManager(
		backend,
		{
			...config,
			monitorPanes: true,
			// Use standalone Bun so the read-only viewer does not inherit OMP's agent identity.
			viewerCommand: (sessionFile, label, paneId) => {
				let token = channelFor(sessionFile, pi);
				const agent = sessionAgents.get(sessionFile);
				if (token && bridge) {
					token = bridge.register(sessionFile);
					const channel = viewerTokens.get(sessionFile);
					if (channel) channel.token = token;
					if (agent) {
						bridge.associate?.(agent.id, sessionFile);
						if (agent.status !== undefined) {
							bridge.publish(agent.id, { type: "state", status: agent.status });
							bridge.finish(agent.id);
							expireChannel(sessionFile);
						}
					}
				}
				const stream = token && bridge
					? ` --socket ${shellQuote(bridge.socketPath)} --token ${shellQuote(token)}`
					: " --stream-unavailable";
				return ` exec ${shellQuote(bun)} ${shellQuote(VIEWER_PATH)} ${shellQuote(sessionFile)} --title ${shellQuote(label)} --parent-pid ${process.pid} --managed --pane-id ${shellQuote(paneId)}${stream}`;
			},
		},
		(message, context) => {
			pi.logger.warn(`herdr-panes: ${message}`, context);
		},
	);
	if (isOwner && !settings.enabled) manager.setEnabled(false);

	if (!subscriptions.has(pi.events)) {
		const unsubscribe = pi.events.on("task:subagent:lifecycle", (data) => {
			try {
				const event = parseLifecycle(data);
				if (event === null) return;
				const file = resolve(event.sessionFile);
				if (event.status === "started") {
					sessionAgents.set(file, { id: event.id });
					const label = `${event.id} · ${event.agent}`;
					if (tree) tree.started(file, label);
					else pendingSessions.set(file, { label });
					if ((settings?.enabled || manager?.has(file)) && channelFor(file, pi) && bridge) {
						const channel = viewerTokens.get(file);
						if (channel) {
							clearTimeout(channel.timer);
							channel.timer = undefined;
						}
						const token = bridge.register(file);
						if (channel) channel.token = token;
						bridge.associate?.(event.id, file);
						bridge.publish(event.id, { type: "live", content: [] });
					}
				} else {
					liveEvents?.clear(event.id);
					bridge?.publish(event.id, { type: "state", status: event.status });
					bridge?.finish(event.id);
					const agent = sessionAgents.get(file);
					if (agent?.id === event.id) agent.status = event.status;
					const finishedAt = Date.now();
					const openIfFinished = Boolean(settings?.enabled || manager?.has(file));
					const pending = pendingSessions.get(file);
					if (pending) {
						pending.status = event.status;
						pending.finishedAt ??= finishedAt;
						pending.openIfFinished ??= openIfFinished;
					}
					tree?.finished(file, event.status, finishedAt, openIfFinished);
					expireChannel(file);
				}
			} catch (error) {
				// An exception escaping an extension callback would take the whole session down.
				pi.logger.warn("herdr-panes: lifecycle handler failed", { error: String(error) });
			}
		});
		const unsubscribeEvents = pi.events.on("task:subagent:event", (data) => liveEvents?.handle(data));
		subscriptions.set(pi.events, () => { unsubscribe(); unsubscribeEvents(); });
	}

	for (const name of ["tool_approval_requested", "tool_approval_resolved", "plan_review_requested", "plan_review_resolved"] as const) {
		pi.on(name, (event, ctx) => {
			const file = ctx.sessionManager.getSessionFile();
			const agent = file ? sessionAgents.get(resolve(file)) : undefined;
			if (agent && agent.status === undefined) liveEvents?.handle({ id: agent.id, event });
		});
	}

	if (isOwner) {
		const currentSettings = settings;
		const currentManager = manager;
		const setRoot = (_event: unknown, ctx: { sessionManager: { getSessionFile(): string | undefined } }): void => {
			const file = ctx.sessionManager.getSessionFile();
			if (!file || tree?.root === resolve(file)) return;
			if (tree) {
				tree.close();
				pendingSessions.clear();
				void currentManager.closeAll();
			}
			tree = new SessionTree(file, currentManager, (error) => pi.logger.warn("herdr-panes: session discovery failed", { error: String(error) }), "active");
			for (const [sessionFile, session] of pendingSessions) {
				tree.started(sessionFile, session.label);
				if (session.status !== undefined) tree.finished(sessionFile, session.status, session.finishedAt, session.openIfFinished);
			}
			pendingSessions.clear();
			tree.start();
		};
		pi.on("session_start", setRoot);
		pi.on("session_switch", setRoot);
		pi.on("before_agent_start", setRoot);
		pi.on("agent_start", setRoot);
		pi.registerCommand("herdr-panes", {
			description: "Control subagent panes and automatic closing",
			getArgumentCompletions: completePaneCommand,
			handler: (args, ctx) => {
				const result = handlePaneCommand(args, currentSettings, currentManager);
				if (currentSettings.enabled) void tree?.scan();
				ctx.ui.notify(result.message, result.type);
			},
		});
		pi.on("session_shutdown", async () => {
			tree?.close();
			tree = undefined;
			pendingSessions.clear();
			for (const unsubscribe of subscriptions.values()) unsubscribe();
			subscriptions.clear();
			for (const channel of viewerTokens.values()) clearTimeout(channel.timer);
			liveEvents?.close();
			await bridge?.close();
			liveEvents = undefined;
			bridge = undefined;
			viewerTokens.clear();
			sessionAgents.clear();
			await manager?.closeAll();
			manager = undefined;
			settings = undefined;
			ownerClaimed = false;
		});
	}
}

/**
 * Oh My Pi extension entry: wire `task:subagent:lifecycle` events to Herdr panes.
 *
 * omp runs this factory again in the same process for every child (subagent) session — children
 * re-bind the parent's extensions — so the very first call belongs to the top-level session. Module
 * state is shared by parent and children, which is exactly what makes a single pane stack possible:
 * `manager` is process-wide and every session's events end up in the same `PaneManager`.
 *
 * Child sessions usually share the parent's event bus, so the lifecycle listener is attached once
 * per bus: one listener per subagent would otherwise pile up and handle every event N times.
 *
 * Outside Herdr the config is `null` and the factory returns without registering anything, so the
 * extension is a silent no-op there.
 */

import { fileURLToPath } from "node:url";
import { parseLifecycle, readConfig, shellQuote } from "./config.ts";
import { createHerdrCli } from "./herdr.ts";
import { LiveBridge } from "./live-bridge.ts";
import { LiveEvents } from "./live-events.ts";
import type { ExtensionAPI, OmpEventBus } from "./omp-types.ts";
import { PaneManager } from "./pane-manager.ts";

/** `src/viewer.ts` next to this module; resolved from this file so any install path works. */
const VIEWER_PATH = fileURLToPath(new URL("./viewer.ts", import.meta.url));

/** One `PaneManager` per process, shared by the parent session and every child session. */
let manager: PaneManager | undefined;
let bridge: LiveBridge | undefined;
let liveEvents: LiveEvents | undefined;
const viewerTokens = new Map<string, { token: string }>();
/** True once some factory call in this process claimed ownership (the first one is the parent). */
let ownerClaimed = false;
/** Unsubscribe function per event bus that already carries our lifecycle listener. */
const subscriptions = new Map<OmpEventBus, () => void>();

export default function ompHerdrPanes(pi: ExtensionAPI): void {
	const config = readConfig(process.env);
	if (config === null) return;

	const bun = Bun.which("bun");
	if (!bun) {
		pi.logger.warn("herdr-panes: standalone Bun is required to run viewer panes");
		return;
	}

	const isOwner = !ownerClaimed;
	ownerClaimed = true;

	if (!bridge) {
		try {
			bridge = new LiveBridge((message, context) => pi.logger.warn(`herdr-panes: ${message}`, context));
			liveEvents = new LiveEvents(bridge);
		} catch (error) {
			pi.logger.warn("herdr-panes: live streaming unavailable", { error: String(error) });
		}
	}

	manager ??= new PaneManager(
		createHerdrCli(),
		{
			...config,
			// Use standalone Bun so Herdr does not detect the read-only viewer as an OMP agent.
			viewerCommand: (sessionFile, label) => {
				const channel = viewerTokens.get(sessionFile);
				viewerTokens.delete(sessionFile);
				const stream = channel && bridge
					? ` --socket ${shellQuote(bridge.socketPath)} --token ${shellQuote(channel.token)}`
					: " --stream-unavailable";
				return ` exec ${shellQuote(bun)} ${shellQuote(VIEWER_PATH)} ${shellQuote(sessionFile)} --title ${shellQuote(label)} --parent-pid ${process.pid}${stream}`;
			},
		},
		(message, context) => {
			pi.logger.warn(`herdr-panes: ${message}`, context);
		},
	);

	if (!subscriptions.has(pi.events)) {
		const unsubscribe = pi.events.on("task:subagent:lifecycle", (data) => {
			try {
				const event = parseLifecycle(data);
				if (event === null) return;
				if (event.status === "started") {
					if (bridge) {
						try {
							const token = bridge.register(event.id);
							viewerTokens.set(event.sessionFile, { token });
							bridge.publish(event.id, { type: "live", content: [] });
						} catch (error) {
							pi.logger.warn("herdr-panes: live streaming unavailable", { error: String(error) });
						}
					}
					void manager?.open(event.sessionFile, `${event.id} · ${event.agent}`);
				} else {
					liveEvents?.clear(event.id);
					bridge?.publish(event.id, { type: "state", status: event.status });
					bridge?.finish(event.id);
					const channel = viewerTokens.get(event.sessionFile);
					if (channel) {
						const timer = setTimeout(() => {
							if (viewerTokens.get(event.sessionFile) === channel) viewerTokens.delete(event.sessionFile);
						}, 5 * 60 * 1000);
						timer.unref();
					}
					manager?.finish(event.sessionFile, event.status);
				}
			} catch (error) {
				// An exception escaping an extension callback would take the whole session down.
				pi.logger.warn("herdr-panes: lifecycle handler failed", { error: String(error) });
			}
		});
		const unsubscribeEvents = pi.events.on("task:subagent:event", (data) => liveEvents?.handle(data));
		subscriptions.set(pi.events, () => { unsubscribe(); unsubscribeEvents(); });
	}

	if (isOwner) {
		pi.on("session_shutdown", async () => {
			for (const unsubscribe of subscriptions.values()) unsubscribe();
			subscriptions.clear();
			liveEvents?.close();
			await bridge?.close();
			liveEvents = undefined;
			bridge = undefined;
			viewerTokens.clear();
			await manager?.closeAll();
			manager = undefined;
			ownerClaimed = false;
		});
	}
}

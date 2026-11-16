import { expect, test } from "bun:test";
import { LiveEvents } from "../src/live-events.ts";
import type { Schedule } from "../src/pane-manager.ts";

function update(id: string, text: string) {
	return { id, event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } } };
}

function fakeSchedule() {
	const callbacks: Array<() => void> = [];
	const schedule: Schedule = (callback) => { callbacks.push(callback); return { cancel() {} }; };
	return { callbacks, schedule };
}

test("coalesces live assistant snapshots independently per agent", () => {
	const frames: Array<{ id: string; frame: unknown }> = [];
	const clock = fakeSchedule();
	const live = new LiveEvents({ publish: (id, frame) => frames.push({ id, frame }) }, clock.schedule);
	live.handle(update("a", "你"));
	live.handle(update("a", "你好"));
	live.handle(update("b", "other"));
	for (const callback of clock.callbacks) callback();
	expect(frames).toEqual([
		{ id: "a", frame: { type: "live", content: [{ type: "text", text: "你好" }] } },
		{ id: "b", frame: { type: "live", content: [{ type: "text", text: "other" }] } },
	]);
	live.close();
});

test("preserves the tool call ID in live snapshots so results can be matched", () => {
	const frames: unknown[] = [];
	const clock = fakeSchedule();
	const live = new LiveEvents({ publish: (_id, frame) => frames.push(frame) }, clock.schedule);
	const content = [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } }];
	live.handle({ id: "a", event: { type: "message_update", message: { role: "assistant", content } } });
	for (const callback of clock.callbacks) callback();
	expect(frames).toEqual([{ type: "live", content: [{ ...content[0], intent: undefined }] }]);
	live.close();
});

test("a finished message cancels even a stale pending partial callback", () => {
	const frames: unknown[] = [];
	const clock = fakeSchedule();
	const live = new LiveEvents({ publish: (_id, frame) => frames.push(frame) }, clock.schedule);
	live.handle(update("a", "incomplete"));
	live.handle({ id: "a", event: { type: "message_end", message: { role: "assistant" } } });
	for (const callback of clock.callbacks) callback();
	expect(frames).toEqual([{ type: "clear" }]);
	live.close();
});

test("large live previews are explicitly truncated without changing the saved transcript", () => {
	const frames: unknown[] = [];
	const clock = fakeSchedule();
	const live = new LiveEvents({ publish: (_id, frame) => frames.push(frame) }, clock.schedule);
	live.handle(update("a", "x".repeat(300_000)));
	for (const callback of clock.callbacks) callback();
	expect(JSON.stringify(frames)).toContain("Live preview truncated; full content appears when saved.");
	live.close();
});

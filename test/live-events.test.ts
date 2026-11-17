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

test("forwards unknown live events and unknown assistant blocks with bounded previews", () => {
	const frames: Array<{ type: string; name?: string; text?: string; content?: unknown[] }> = [];
	const clock = fakeSchedule();
	const live = new LiveEvents({ publish: (_id, frame) => frames.push(frame as typeof frames[number]) }, clock.schedule);
	live.handle({ id: "a", event: { type: "new_event", data: "hello" } });
	live.handle({ id: "a", event: { type: "message_update", message: { role: "assistant", content: [{ type: "future_block", value: "payload" }] } } });
	for (const callback of clock.callbacks) callback();
	expect(frames[0]?.name).toBe("new_event");
	expect(frames[0]?.text).toContain("hello");
	expect(frames[1]?.content).toEqual([{ type: "unknown_live_block", originalType: "future_block", preview: '{\n  "type": "future_block",\n  "value": "payload"\n}' }]);
	live.handle({ id: "a", event: { type: "large", data: "x".repeat(100_000) } });
	expect(frames.at(-1)?.text).toContain("[Live event truncated.]");
	live.close();
});

test("preserves the call ID and progress when execution update arguments are large", () => {
	const frames: Array<{ name?: string; text?: string; toolCallId?: string }> = [];
	const live = new LiveEvents({ publish: (_id, frame) => frames.push(frame as typeof frames[number]) });
	live.handle({ id: "agent", event: {
		type: "tool_execution_update", toolCallId: "call-1", toolName: "bash",
		args: { input: "x".repeat(100_000) }, partialResult: { content: [{ type: "text", text: "working" }] },
	} });
	expect(frames[0]?.toolCallId).toBe("call-1");
	expect(frames[0]?.text).toContain("working");
	expect(frames[0]?.text).not.toContain("[Live event truncated.]");
	live.close();
});

test("forwards association IDs and bounded IRC, tool results and plan reviews", () => {
	const frames: Array<{ name: string; text: string; toolCallId?: string }> = [];
	const live = new LiveEvents({ publish: (_id, frame) => frames.push(frame as typeof frames[number]) });
	for (const type of ["tool_execution_end", "tool_approval_requested", "tool_approval_resolved", "tool_stream_update"]) {
		live.handle({ id: "agent", event: { type, toolCallId: "call", result: { content: "x".repeat(100_000) }, update: { preview: "diff" } } });
	}
	live.handle({ id: "agent", event: { type: "irc_message", message: {
		customType: "irc:incoming", display: true, content: "x".repeat(100_000), details: { id: "irc-id" },
	} } });
	live.handle({ id: "agent", event: { type: "plan_review_requested", reviewId: "review", planContent: "x".repeat(100_000) } });
	expect(frames.slice(0, 4).map(frame => frame.toolCallId)).toEqual(["call", "call", "call", "call"]);
	expect(JSON.parse(frames[0]!.text).result).toContain("[Live event truncated.]");
	expect(JSON.parse(frames[3]!.text).preview).toBe("diff");
	expect(JSON.parse(frames[4]!.text).message.details.id).toBe("irc-id");
	expect(JSON.parse(frames[4]!.text).message.content).toContain("[Live event truncated.]");
	expect(JSON.parse(frames[5]!.text).reviewId).toBe("review");
	live.close();
});

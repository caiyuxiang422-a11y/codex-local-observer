import { describe, expect, it } from "vitest";
import {
  formatDuration,
  initialMonitorState,
  monitorReducer,
  type TaskEvent,
} from "./taskModel";

function event(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    schemaVersion: 1,
    eventId: "task-1:1",
    taskId: "task-1",
    sequence: 1,
    source: "codex_exec",
    receivedAt: 1_000,
    kind: "thread",
    severity: "info",
    label: "Codex 会话已建立",
    ...overrides,
  };
}

describe("monitorReducer", () => {
  it("moves through starting, running and completed", () => {
    const starting = monitorReducer(initialMonitorState, {
      type: "start-requested",
      at: 100,
    });
    const running = monitorReducer(starting, {
      type: "event-received",
      event: event({ taskState: "running" }),
    });
    const completed = monitorReducer(running, {
      type: "event-received",
      event: event({
        eventId: "task-1:2",
        sequence: 2,
        receivedAt: 2_000,
        taskState: "completed",
        severity: "success",
        exitCode: 0,
      }),
    });

    expect(running.status).toBe("running");
    expect(completed.status).toBe("completed");
    expect(completed.endedAt).toBe(2_000);
    expect(completed.exitCode).toBe(0);
  });

  it("does not let a late stream event undo stopping", () => {
    const stopping = monitorReducer(
      { ...initialMonitorState, status: "stopping", taskId: "task-1" },
      { type: "event-received", event: event({ taskState: "running" }) },
    );
    expect(stopping.status).toBe("stopping");
  });

  it("locks a terminal state against late non-terminal events", () => {
    const completed = {
      ...initialMonitorState,
      status: "completed" as const,
      taskId: "task-1",
    };
    const afterLateEvent = monitorReducer(completed, {
      type: "event-received",
      event: event({ taskState: "running" }),
    });
    expect(afterLateEvent.status).toBe("completed");
    expect(afterLateEvent.totalEventCount).toBe(1);
  });

  it("ignores events from an older task", () => {
    const state = {
      ...initialMonitorState,
      status: "running" as const,
      taskId: "current",
    };
    expect(
      monitorReducer(state, {
        type: "event-received",
        event: event({ taskId: "old" }),
      }),
    ).toBe(state);
  });

  it("keeps usage as a reported snapshot instead of summing it", () => {
    const first = monitorReducer(initialMonitorState, {
      type: "event-received",
      event: event({ usage: { inputTokens: 10, outputTokens: 2 } }),
    });
    const second = monitorReducer(first, {
      type: "event-received",
      event: event({
        sequence: 2,
        usage: { inputTokens: 15, outputTokens: 3 },
      }),
    });
    expect(second.usage).toEqual({ inputTokens: 15, outputTokens: 3 });
  });
});

describe("formatDuration", () => {
  it("formats seconds and minutes for people", () => {
    expect(formatDuration(9_900)).toBe("9秒");
    expect(formatDuration(65_000)).toBe("1分 5秒");
  });
});

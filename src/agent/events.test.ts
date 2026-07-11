/**
 * EventBus 和 AgentEvent 类型的测试。
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test"
import { eventBus } from "./events"
import type { AgentEvent } from "./events"

describe("EventBus", () => {
  beforeEach(() => {
    eventBus.clear()
  })

  afterAll(() => {
    eventBus.clear()
  })

  test("订阅后能收到事件", () => {
    const received: AgentEvent[] = []
    eventBus.on((evt) => received.push(evt))

    eventBus.emit({
      type: "stream_chunk",
      payload: { delta: "Hello" },
    })

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe("stream_chunk")
    if (received[0].type === "stream_chunk") {
      expect(received[0].payload.delta).toBe("Hello")
    }
  })

  test("取消订阅后不再收到事件", () => {
    const received: AgentEvent[] = []
    const unsub = eventBus.on((evt) => received.push(evt))

    unsub()

    eventBus.emit({
      type: "provider_changed",
      payload: { providerId: "test", model: "gpt-4" },
    })

    expect(received).toHaveLength(0)
  })

  test("多个订阅者都能收到事件", () => {
    const a: AgentEvent[] = []
    const b: AgentEvent[] = []
    eventBus.on((evt) => a.push(evt))
    eventBus.on((evt) => b.push(evt))

    eventBus.emit({
      type: "stream_done",
      payload: { totalText: "done", stopReason: "stop" },
    })

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  test("一个订阅者抛出异常不会影响其他订阅者", () => {
    const received: AgentEvent[] = []
    eventBus.on(() => {
      throw new Error("oops")
    })
    eventBus.on((evt) => received.push(evt))

    eventBus.emit({
      type: "stream_chunk",
      payload: { delta: "still works" },
    })

    expect(received).toHaveLength(1)
  })

  test("clear 移除所有订阅者", () => {
    const received: AgentEvent[] = []
    eventBus.on((evt) => received.push(evt))
    eventBus.clear()

    eventBus.emit({
      type: "provider_changed",
      payload: { providerId: "x", model: "y" },
    })

    expect(received).toHaveLength(0)
  })

  test("正确发送所有事件类型变体", () => {
    const received: AgentEvent[] = []
    eventBus.on((evt) => received.push(evt))

    const events: AgentEvent[] = [
      { type: "stream_chunk", payload: { delta: "a" } },
      { type: "stream_done", payload: { totalText: "abc", stopReason: "stop" } },
      { type: "stream_error", payload: { kind: "auth_failed", message: "bad key" } },
      { type: "provider_changed", payload: { providerId: "p1", model: "m1" } },
      { type: "provider_change_error", payload: { providerId: "p1", reason: "write failed" } },
    ]

    for (const evt of events) {
      eventBus.emit(evt)
    }

    expect(received).toHaveLength(5)
    expect(received.map((e) => e.type)).toEqual([
      "stream_chunk",
      "stream_done",
      "stream_error",
      "provider_changed",
      "provider_change_error",
    ])
  })
})

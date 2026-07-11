/**
 * AgentEvent —— paw 事件系统的权威类型定义。
 *
 * ⚠️  规则（P0-01）：本文件是所有 AgentEvent 类型的单一权威来源。
 * 后续 Spec 只允许在此追加新的事件类型。不得重定义或修改已有类型 ——
 * 而是向联合类型中添加新的成员。
 *
 * 当前覆盖：Spec 1 事件（stream + provider 切换）。
 * 下一步：Spec 2 将添加 Agent 生命周期事件。
 *
 * 每个事件使用嵌套的 `{ type, payload }` 结构。
 */

import type { LLMErrorKind } from "./provider/errors"

// ── Spec 1：Stream 和 Provider 切换事件 ─────────────────────────────────────

export interface StreamChunkEvent {
  type: "stream_chunk"
  payload: { delta: string }
}

export interface StreamDoneEvent {
  type: "stream_done"
  payload: { totalText: string; stopReason: "stop" | "tool_use" }
}

export interface StreamErrorEvent {
  type: "stream_error"
  payload: { kind: LLMErrorKind; message: string }
}

export interface ProviderChangedEvent {
  type: "provider_changed"
  payload: { providerId: string; model: string }
}

export interface ProviderChangeErrorEvent {
  type: "provider_change_error"
  payload: { providerId: string; reason: string }
}

// ── 联合类型（Spec 1）─────────────────────────────────────────────────────────

export type AgentEvent =
  | StreamChunkEvent
  | StreamDoneEvent
  | StreamErrorEvent
  | ProviderChangedEvent
  | ProviderChangeErrorEvent

// ── EventBus ─────────────────────────────────────────────────────────────────

type EventHandler = (event: AgentEvent) => void

/**
 * 简单的类型化事件总线。
 *
 * 同时被 ProviderRegistry（发送方）和 TUI / AgentRunner（接收方）使用。
 * 当前使用全局单例保持简单；如果性能成为问题，可以改用按通道分离的 EventEmitter。
 */
class EventBus {
  private handlers = new Set<EventHandler>()

  /** 订阅所有 AgentEvent。返回取消订阅的函数。 */
  on(handler: EventHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** 向所有订阅者发送事件。 */
  emit(event: AgentEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event)
      } catch {
        // 吞掉订阅者的异常，保持总线存活
      }
    }
  }

  /** 移除所有订阅者。 */
  clear(): void {
    this.handlers.clear()
  }
}

/** 全局单例事件总线。 */
export const eventBus = new EventBus()

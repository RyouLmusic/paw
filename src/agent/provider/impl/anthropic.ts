/**
 * Anthropic provider 实现。
 *
 * 使用原生 `fetch`（不使用 Anthropic SDK），手工编写 SSE 事件解析器，
 * 解析 Anthropic Messages API 的事件格式。
 *
 * 事件流程：
 *   event: content_block_delta  →  delta.text 作为 StreamChunk 产出
 *   event: message_delta        →  捕获 stop_reason
 *   event: message_stop         →  产出 final done=true 的块
 *   event: ping                 →  心跳，忽略
 */

import type { ChatMessage, LLMProvider, StreamChunk } from "../types"
import type { AnthropicProviderConfig } from "../types"
import { LLMError } from "../errors"

// ── Anthropic SSE 内部解析类型 ───────────────────────────────────────────────

interface AnthropicSSEEvent {
  event: string
  data: Record<string, unknown>
}

/**
 * 将原始 SSE 文本行解析为结构化事件。
 * Anthropic 的 SSE 格式使用：
 *   event: <类型>\n
 *   data: <json>\n
 *   \n
 */
function parseAnthropicSSE(buffer: string): AnthropicSSEEvent[] {
  const events: AnthropicSSEEvent[] = []
  const blocks = buffer.split("\n\n")

  for (const block of blocks) {
    if (!block.trim()) continue

    const lines = block.split("\n")
    let event = ""
    let data: Record<string, unknown> = {}

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        event = line.slice(7).trim()
      } else if (line.startsWith("data: ")) {
        const raw = line.slice(6).trim()
        if (raw) {
          try {
            data = JSON.parse(raw)
          } catch {
            // 跳过格式错误的 data
          }
        }
      }
    }

    if (event) {
      events.push({ event, data })
    }
  }

  return events
}

// ── Provider 类 ──────────────────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  readonly id: string
  readonly label: string
  readonly model: string
  readonly config: AnthropicProviderConfig

  constructor(config: AnthropicProviderConfig) {
    this.id = config.id
    this.label = config.label
    this.model = config.model
    this.config = config
  }

  async *stream(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const baseURL = this.config.baseURL ?? "https://api.anthropic.com"
    const url = `${baseURL.replace(/\/$/, "")}/v1/messages`

    const systemMessages = messages.filter((m) => m.role === "system")
    const chatMessages = messages.filter((m) => m.role !== "system")

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey ?? "",
      "anthropic-version": "2023-06-01",
    }

    const body = JSON.stringify({
      model: this.model,
      messages: chatMessages.map((m) => ({ role: m.role, content: m.content })),
      ...(systemMessages.length > 0
        ? { system: systemMessages.map((m) => m.content) }
        : {}),
      stream: true,
    })

    let response: Response | undefined

    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal,
      })
    } catch (err) {
      if (err instanceof TypeError || (err instanceof Error && err.name === "AbortError")) {
        throw LLMError.fromNetworkError(err)
      }
      throw err
    }

    if (!response.ok) {
      throw await LLMError.fromResponse(response)
    }

    yield* this.parseAnthropicStream(response, signal)
  }

  private async *parseAnthropicStream(
    response: Response,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const reader = response.body?.getReader()
    if (!reader) {
      throw new LLMError("unknown", "响应体不可读")
    }

    try {
      const decoder = new TextDecoder()
      let buffer = ""
      let stopReason: "stop" | "tool_use" | undefined

      const onAbort = () => {
        reader.cancel().catch(() => {})
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // 处理完整的事件块（以 \n\n 分隔）
        const events = parseAnthropicSSE(buffer)

        if (events.length > 0) {
          // 保留尾部可能不完整的数据到 buffer
          const lastDoubleNewline = buffer.lastIndexOf("\n\n")
          buffer = lastDoubleNewline >= 0 ? buffer.slice(lastDoubleNewline + 2) : buffer
        }

        for (const evt of events) {
          switch (evt.event) {
            case "content_block_delta": {
              const delta = evt.data as {
                delta?: { text?: string; type?: string }
              }
              const text = delta.delta?.text
              if (text) {
                yield { delta: text, done: false }
              }
              break
            }

            case "message_delta": {
              const delta = evt.data as {
                delta?: { stop_reason?: string; stop_sequence?: string | null }
              }
              if (delta.delta?.stop_reason === "tool_use") {
                stopReason = "tool_use"
              } else if (delta.delta?.stop_reason === "end_turn") {
                stopReason = "stop"
              }
              break
            }

            case "message_stop": {
              yield { delta: "", done: true, stopReason }
              return
            }

            // ping 心跳 —— 忽略
            case "ping":
            // content_block_start —— 忽略，块开始时不产出文本
            case "content_block_start":
            case "message_start":
            default:
              break
          }
        }
      }

      // 如果 stream 在没有 message_stop 事件的情况下结束
      yield { delta: "", done: true, stopReason }
    } finally {
      // P2-17：取消底层 stream
      try {
        reader.releaseLock()
      } catch { /* reader 可能已释放 */ }
      try {
        await response.body?.cancel()
      } catch {
        // stream 可能已处于关闭/错误状态
      }
    }
  }
}

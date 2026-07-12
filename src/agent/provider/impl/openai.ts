/**
 * OpenAI / openai-compat provider 实现。
 *
 * 同时支持 `"openai"` 和 `"openai-compat"` 两种配置类型 ——
 * 它们使用完全相同的 HTTP 协议（OpenAI Chat Completions SSE）。
 *
 * 导出 `parseStream` 作为共享工具函数，供 Azure 和 Ollama provider 复用。
 */

import type { ChatMessage, LLMProvider, StreamChunk } from "../types"
import { LLMError } from "../errors"
import type { OpenAIProviderConfig } from "../types"

// ── SSE 解析器（共享）─────────────────────────────────────────────────────────

/**
 * 解析 OpenAI 兼容的 SSE 响应体为 AsyncIterable<StreamChunk>。
 *
 * 处理以下格式：
 *   - `data: {"choices":[{"delta":{"content":"..."}}]}`（普通文本）
 *   - `data: {"choices":[{"delta":{"content":"","reasoning_content":"..."}}]}`（thinking 内容，o 系列模型）
 *   - `data: {"choices":[{"delta":{"reasoning_content":null}}]}`（thinking 结束标记）
 *   - `data: [DONE]`（stream 结束标记）
 *   - 空的 `data:` 心跳行
 *
 * 约束：thinkingDelta 与 delta 互斥，同一 chunk 中只含其一。
 *
 * **必须**包含 `try/finally` 块，在 abort 或异常时取消 ReadableStream（P2-17 合规）。
 */
export async function* parseStream(
  response: Response,
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new LLMError("unknown", "响应体不可读")
  }

  // 注册 abort 监听器 —— 提前释放 reader 以便 cancel 正常工作
  signal?.addEventListener(
    "abort",
    () => {
      reader.cancel().catch(() => {})
    },
    { once: true },
  )

  try {
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      // 保留最后一（可能不完整的）行到 buffer 中
      buffer = lines.pop() ?? ""

      for (const raw of lines) {
        if (!raw.startsWith("data: ")) continue

        const payload = raw.slice(6).trim()

        // OpenAI stream 结束标记
        if (payload === "[DONE]") {
          yield { delta: "", done: true }
          return
        }

        // 空心跳行
        if (!payload) continue

        try {
          const parsed = JSON.parse(payload)
          const choice = parsed.choices?.[0]
          const deltaContent = choice?.delta?.content ?? ""
          const reasoningContent = choice?.delta?.reasoning_content
          const finishReason = choice?.finish_reason ?? null

          // 处理 reasoning_content（OpenAI o 系列模型的 thinking 内容）
          if (reasoningContent && typeof reasoningContent === "string") {
            yield { delta: "", done: false, thinkingDelta: reasoningContent }
          }

          // 处理普通正文 delta
          if (deltaContent) {
            yield { delta: deltaContent, done: false }
          }

          // 当 finish_reason 存在时，stream 结束
          if (finishReason) {
            yield {
              delta: "",
              done: true,
              stopReason: finishReason === "tool_calls" ? "tool_use" : "stop",
            }
            return
          }
        } catch {
          // 跳过格式错误的 JSON 行
        }
      }
    }

    // 在没有 [DONE] 或 finish_reason 的情况下 stream 结束
    yield { delta: "", done: true }
  } finally {
    // P2-17：取消底层 stream 防止泄漏。
    // 先释放 reader 锁，避免 .cancel() 抛出异常。
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

// ── Provider 类 ──────────────────────────────────────────────────────────────

export class OpenAIProvider implements LLMProvider {
  readonly id: string
  readonly label: string
  readonly model: string
  readonly config: OpenAIProviderConfig

  constructor(config: OpenAIProviderConfig) {
    this.id = config.id
    this.label = config.label
    this.model = config.model
    this.config = config
  }

  async *stream(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const baseURL = this.config.baseURL ?? "https://api.openai.com/v1"
    const url = `${baseURL.replace(/\/$/, "")}/chat/completions`

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }

    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`
    }

    const body = JSON.stringify({
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    })

    let response: Response

    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal,
      })
    } catch (err) {
      // 网络故障（超时、DNS 解析失败、连接被拒绝）
      if (err instanceof TypeError || (err instanceof Error && err.name === "AbortError")) {
        throw LLMError.fromNetworkError(err)
      }
      throw err
    }

    if (!response.ok) {
      throw await LLMError.fromResponse(response)
    }

    yield* parseStream(response, signal)
  }
}

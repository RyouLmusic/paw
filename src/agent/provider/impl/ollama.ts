/**
 * Ollama provider 实现。
 *
 * Ollama 暴露了 OpenAI 兼容的 `/v1/chat/completions` 端点，
 * 因此复用 `openai.ts` 的 SSE 解析器和请求逻辑。
 *
 * 与 OpenAI 的主要区别：
 *   - 默认 baseURL 是 `http://localhost:11434`（非 HTTPS）
 *   - 不需要 API Key
 *   - 网络故障多半意味着本地 Ollama 服务未启动
 */

import type { ChatMessage, LLMProvider, StreamChunk } from "../types"
import type { OllamaProviderConfig } from "../types"
import { LLMError } from "../errors"

// 复用 OpenAI 的 SSE 解析器
import { parseStream } from "./openai"

export class OllamaProvider implements LLMProvider {
  readonly id: string
  readonly label: string
  readonly model: string
  readonly config: OllamaProviderConfig

  constructor(config: OllamaProviderConfig) {
    this.id = config.id
    this.label = config.label
    this.model = config.model
    this.config = config
  }

  async *stream(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const baseURL = this.config.baseURL ?? "http://localhost:11434"
    const url = `${baseURL.replace(/\/$/, "")}/v1/chat/completions`

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
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
      // Ollama 未运行 → 网络超时，附带友好提示
      if (err instanceof TypeError || (err instanceof Error && err.name === "AbortError")) {
        throw new LLMError(
          "network_timeout",
          "无法连接到 Ollama 服务，请确认本地 Ollama 已启动（默认 http://localhost:11434）",
        )
      }
      throw err
    }

    if (!response.ok) {
      throw await LLMError.fromResponse(response)
    }

    yield* parseStream(response, signal)
  }
}

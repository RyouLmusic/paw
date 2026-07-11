/**
 * LLMError 类和 LLMErrorKind 类型的测试。
 */

import { test, expect, describe } from "bun:test"
import { LLMError } from "./errors"
import type { LLMErrorKind } from "./errors"

describe("LLMError", () => {
  test("创建带有 kind 和 message 的错误", () => {
    const err = new LLMError("auth_failed", "Invalid API key")
    expect(err.kind).toBe("auth_failed")
    expect(err.message).toBe("Invalid API key")
    expect(err.name).toBe("LLMError")
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(LLMError)
  })

  test("fromHttpStatus: 401 → auth_failed", () => {
    const err = LLMError.fromHttpStatus(401)
    expect(err.kind).toBe("auth_failed")
  })

  test("fromHttpStatus: 429 → rate_limited", () => {
    const err = LLMError.fromHttpStatus(429)
    expect(err.kind).toBe("rate_limited")
  })

  test("fromHttpStatus: 404 → model_not_found", () => {
    const err = LLMError.fromHttpStatus(404)
    expect(err.kind).toBe("model_not_found")
  })

  test("fromHttpStatus: 500 → server_error", () => {
    const err = LLMError.fromHttpStatus(500)
    expect(err.kind).toBe("server_error")
  })

  test("fromHttpStatus: 503 → server_error", () => {
    const err = LLMError.fromHttpStatus(503)
    expect(err.kind).toBe("server_error")
  })

  test("fromHttpStatus: 400 → unknown", () => {
    const err = LLMError.fromHttpStatus(400)
    expect(err.kind).toBe("unknown")
  })

  test("fromHttpStatus: 200 → unknown（意外的成功状态码）", () => {
    const err = LLMError.fromHttpStatus(200)
    expect(err.kind).toBe("unknown")
  })

  test("fromHttpStatus: 消息中附带响应体内容", () => {
    const err = LLMError.fromHttpStatus(401, '{"error":"unauthorized"}')
    expect(err.message).toContain("unauthorized")
  })

  test("fromNetworkError: TypeError → network_timeout", () => {
    const err = LLMError.fromNetworkError(new TypeError("fetch failed"))
    expect(err.kind).toBe("network_timeout")
    expect(err.message).toContain("fetch failed")
  })

  test("fromNetworkError: 字符串原因 → network_timeout", () => {
    const err = LLMError.fromNetworkError("connection refused")
    expect(err.kind).toBe("network_timeout")
  })

  test("fromResponse: 读取响应体并映射状态码", async () => {
    const mockRes = new Response('{"error":"rate limited"}', {
      status: 429,
      headers: { "content-type": "application/json" },
    })
    const err = await LLMError.fromResponse(mockRes)
    expect(err.kind).toBe("rate_limited")
    expect(err.message).toContain("rate limited")
  })

  test("fromResponse: 不可读的响应体也能优雅处理", async () => {
    // 响应体已被消费的 Response
    const res = new Response("ok", { status: 500 })
    res.text() // 先消费响应体
    const err = await LLMError.fromResponse(res) // 再次读取会失败
    expect(err.kind).toBe("server_error")
  })

  test("LLMErrorKind 类型是预期的联合类型", () => {
    // 编译时检查：确保类型正确，赋值所有变体
    const kinds: LLMErrorKind[] = [
      "auth_failed",
      "rate_limited",
      "network_timeout",
      "model_not_found",
      "server_error",
      "unknown",
    ]
    expect(kinds).toHaveLength(6)
  })
})

/**
 * Provider 测试的共享辅助函数。
 *
 * 提供类型正确的 fetch mock，满足 Bun 扩展后的 fetch 签名（含 `.preconnect`）。
 */

export function createMockFetch(
  makeResponse: (url: string, opts?: RequestInit) => Partial<Response>,
): typeof fetch {
  // 返回与 fetch 调用/构造签名匹配的函数
  const mock: any = async (input: URL | Request | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    return makeResponse(url, init) as Response
  }
  mock.preconnect = async () => {}
  return mock as typeof fetch
}

export function simpleMockResponse(resp: Partial<Response>): typeof fetch {
  return createMockFetch(() => resp)
}

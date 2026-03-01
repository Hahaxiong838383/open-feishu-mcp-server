import type { FeishuContext } from 'feishu-tools';

/**
 * 从 FeishuContext 解析 user_access_token。
 */
export const resolveToken = async (
  provider: FeishuContext['getUserAccessToken'],
): Promise<string | undefined> => {
  if (!provider) return undefined;
  if (typeof provider === 'function') {
    const token = await provider();
    return token || undefined;
  }
  return provider;
};

/** MCP 工具标准返回格式 */
export interface McpResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * 飞书 OpenAPI 通用 fetch 封装。
 *
 * - 自动拼 `https://open.feishu.cn/open-apis/` 前缀
 * - 自动注入 Authorization header
 * - 统一返回 MCP 格式
 * - 遇到 401 时自动重新获取 token 并重试一次
 */
export async function feishuFetch(opts: {
  context: FeishuContext;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}): Promise<McpResult> {
  return _feishuFetchWithRetry(opts, false);
}

async function _feishuFetchWithRetry(
  opts: {
    context: FeishuContext;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  },
  isRetry: boolean,
): Promise<McpResult> {
  const token = await resolveToken(opts.context.getUserAccessToken);
  if (!token) {
    return {
      isError: true,
      content: [{ type: 'text', text: '缺少 user_access_token，无法调用飞书 API。请先完成授权。' }],
    };
  }

  // 拼接完整 URL
  const pathNormalized = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;
  const url = new URL(`/open-apis${pathNormalized}`, 'https://open.feishu.cn');

  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  let body: string | undefined;
  if (opts.method !== 'GET' && opts.body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(opts.body);
  }

  try {
    const resp = await fetch(url.toString(), {
      method: opts.method,
      headers,
      body,
    });

    const respText = await resp.text();
    let parsed: unknown = respText;
    try { parsed = JSON.parse(respText); } catch { /* 保留原文 */ }

    const parsedObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;

    // 401 且未重试过 → 重新获取 token 再试一次
    if (resp.status === 401 && !isRetry) {
      // 飞书有时返回 200 但 code != 0 表示 token 无效，也检查
      console.log('[feishuFetch] 收到 401，自动重试...');
      return _feishuFetchWithRetry(opts, true);
    }

    // 飞书 API 有时返回 200 但 code=99991663/99991664 表示 token 过期
    if (
      !isRetry &&
      resp.ok &&
      parsedObj &&
      typeof parsedObj.code === 'number' &&
      (parsedObj.code === 99991663 || parsedObj.code === 99991664)
    ) {
      console.log('[feishuFetch] 飞书返回 token 过期 code:', parsedObj.code, '，自动重试...');
      return _feishuFetchWithRetry(opts, true);
    }

    if (resp.ok) {
      const result = parsedObj && 'data' in parsedObj ? parsedObj.data : parsed;
      const payload = { ok: true, status: resp.status, result };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    }

    const payload = { ok: false, status: resp.status, error: parsed || respText };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '飞书 API 调用时发生未知错误';
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
    };
  }
}

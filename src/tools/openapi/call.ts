import { z } from 'zod';
import type { ToolDefinition, FeishuContext } from 'feishu-tools';

const resolveToken = async (provider: FeishuContext['getUserAccessToken']): Promise<string | undefined> => {
  if (!provider) {
    return undefined;
  }

  if (typeof provider === 'function') {
    const token = await provider();
    return token || undefined;
  }

  return provider;
};

const safeJsonParse = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const feishuOpenApiCall: ToolDefinition = {
  name: 'feishu_openapi_call',
  description: '飞书 OpenAPI 万能调用工具：按 method + path + query + body 调用任意 open-apis 接口，覆盖当前未单独封装的全部能力。',
  inputSchema: {
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP 方法'),
    path: z.string().describe('接口路径，例如 /im/v1/messages 或 /open-apis/im/v1/messages'),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('查询参数对象'),
    headers: z.record(z.string(), z.string()).optional().describe('可选附加请求头'),
    body: z.union([z.record(z.string(), z.any()), z.array(z.any()), z.string()]).optional().describe('请求体，字符串会按原文发送，对象/数组会自动 JSON 序列化'),
  },
  callback: async (context, args) => {
    const token = await resolveToken(context.getUserAccessToken);

    if (!token) {
      return {
        isError: true,
        content: [{ type: 'text', text: '缺少 user_access_token，无法调用飞书 OpenAPI。' }],
      };
    }

    const normalizedPath = args.path.startsWith('/open-apis')
      ? args.path
      : `/open-apis${args.path.startsWith('/') ? '' : '/'}${args.path}`;

    const url = new URL(`https://open.feishu.cn${normalizedPath}`);
    if (args.query) {
      Object.entries(args.query).forEach(([key, value]) => {
        url.searchParams.set(key, String(value));
      });
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...args.headers,
    };

    let body: string | undefined;
    if (typeof args.body === 'string') {
      body = args.body;
    } else if (typeof args.body !== 'undefined') {
      body = JSON.stringify(args.body);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const response = await fetch(url.toString(), {
      method: args.method,
      headers,
      body,
    });

    const responseText = await response.text();
    const parsed = safeJsonParse(responseText);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              status: response.status,
              ok: response.ok,
              headers: (() => {
                const responseHeaders: Record<string, string> = {};
                response.headers.forEach((value, key) => {
                  responseHeaders[key] = value;
                });
                return responseHeaders;
              })(),
              data: parsed,
            },
            null,
            2,
          ),
        },
      ],
      isError: !response.ok,
    };
  },
};

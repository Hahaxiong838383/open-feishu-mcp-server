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

const headersToObject = (headers: Headers): Record<string, string> => {
  const responseHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  return responseHeaders;
};

const normalizePath = (path: string): string => {
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  const prefixed = withLeadingSlash.startsWith('/open-apis/') || withLeadingSlash === '/open-apis'
    ? withLeadingSlash
    : `/open-apis${withLeadingSlash}`;
  return prefixed.replace(/\/+/g, '/');
};

const decodeBase64 = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'base64'));
const encodeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

const inferFilenameFromUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts.at(-1) || 'file';
  } catch {
    return 'file';
  }
};

const appendMultipartFile = async (
  formData: FormData,
  file: {
    fieldName: string;
    filename?: string;
    contentType?: string;
    dataBase64?: string;
    url?: string;
  },
): Promise<void> => {
  if (file.dataBase64) {
    const contentType = file.contentType || 'application/octet-stream';
    const filename = file.filename || 'file';
    const blob = new Blob([decodeBase64(file.dataBase64)], { type: contentType });
    formData.append(file.fieldName, blob, filename);
    return;
  }

  if (file.url) {
    const fileResponse = await fetch(file.url);
    const buffer = await fileResponse.arrayBuffer();
    const contentType = file.contentType || fileResponse.headers.get('content-type') || 'application/octet-stream';
    const filename = file.filename || inferFilenameFromUrl(file.url);
    const blob = new Blob([buffer], { type: contentType });
    formData.append(file.fieldName, blob, filename);
    return;
  }

  throw new Error(`multipart 文件字段 ${file.fieldName} 缺少 dataBase64 或 url`);
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
    bodyType: z.enum(['json', 'text', 'form', 'multipart']).optional().default('json').describe('请求体编码方式，默认 json'),
    form: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('表单字段，form/multipart 模式可用'),
    files: z.array(z.object({
      fieldName: z.string(),
      filename: z.string().optional(),
      contentType: z.string().optional(),
      dataBase64: z.string().optional(),
      url: z.string().optional(),
    })).optional().describe('multipart 文件列表，支持 base64 或 URL'),
    responseMode: z.enum(['json', 'text', 'binaryBase64']).optional().default('json').describe('响应解析模式，默认 json'),
  },
  callback: async (context, args) => {
    const token = await resolveToken(context.getUserAccessToken);

    if (!token) {
      return {
        isError: true,
        content: [{ type: 'text', text: '缺少 user_access_token，无法调用飞书 OpenAPI。' }],
      };
    }

    try {
      const normalizedPath = normalizePath(args.path);
      const url = new URL(normalizedPath, 'https://open.feishu.cn');
      if (args.query) {
        Object.entries(args.query).forEach(([key, value]) => {
          url.searchParams.set(key, String(value));
        });
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        ...args.headers,
      };

      let body: BodyInit | undefined;
      const bodyType = args.bodyType || 'json';

      if (bodyType === 'text') {
        if (typeof args.body !== 'string') {
          throw new Error('bodyType=text 时 body 必须是 string');
        }
        body = args.body;
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'text/plain;charset=utf-8';
        }
      } else if (bodyType === 'form') {
        const payload = typeof args.body === 'undefined' ? args.form : args.body;
        if (typeof payload === 'undefined') {
          throw new Error('bodyType=form 时需提供 body 或 form');
        }
        if (typeof payload === 'string') {
          body = payload;
        } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const searchParams = new URLSearchParams();
          Object.entries(payload).forEach(([key, value]) => {
            searchParams.set(key, String(value));
          });
          body = searchParams;
        } else {
          throw new Error('bodyType=form 时 body 仅支持 string 或对象');
        }
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      } else if (bodyType === 'multipart') {
        if (!args.form && !args.files?.length && typeof args.body === 'undefined') {
          throw new Error('bodyType=multipart 时至少提供 form、files 或 body');
        }

        const formData = new FormData();
        if (args.form) {
          Object.entries(args.form).forEach(([key, value]) => {
            formData.append(key, String(value));
          });
        }

        if (typeof args.body !== 'undefined') {
          if (typeof args.body === 'string') {
            throw new Error('bodyType=multipart 时 body 需为对象（键值对）');
          }
          if (Array.isArray(args.body)) {
            throw new Error('bodyType=multipart 时 body 不能为数组');
          }
          Object.entries(args.body).forEach(([key, value]) => {
            formData.append(key, String(value));
          });
        }

        if (args.files?.length) {
          for (const file of args.files) {
            await appendMultipartFile(formData, file);
          }
        }

        delete headers['Content-Type'];
        body = formData;
      } else {
        if (typeof args.body === 'string') {
          body = args.body;
        } else if (typeof args.body !== 'undefined') {
          body = JSON.stringify(args.body);
        }
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      const response = await fetch(url.toString(), {
        method: args.method,
        headers,
        body,
      });

      const responseHeaders = headersToObject(response.headers);
      const responseMode = args.responseMode || 'json';

      let payload: Record<string, unknown>;

      if (responseMode === 'binaryBase64') {
        const buffer = await response.arrayBuffer();
        payload = {
          ok: response.ok,
          status: response.status,
          headers: responseHeaders,
          contentType: response.headers.get('content-type') || undefined,
          dataBase64: encodeBase64(new Uint8Array(buffer)),
        };
      } else {
        const responseText = await response.text();
        const data = responseMode === 'text' ? responseText : safeJsonParse(responseText);

        if (!response.ok) {
          payload = {
            ok: false,
            status: response.status,
            headers: responseHeaders,
            error: {
              message: `飞书 OpenAPI 请求失败（HTTP ${response.status}）`,
              raw: data,
            },
          };
        } else {
          payload = {
            ok: response.ok,
            status: response.status,
            headers: responseHeaders,
            data,
          };
        }
      }

      if (!response.ok && responseMode === 'binaryBase64') {
        payload = {
          ok: false,
          status: response.status,
          headers: responseHeaders,
          error: {
            message: `飞书 OpenAPI 请求失败（HTTP ${response.status}）`,
            raw: payload,
          },
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
        isError: !response.ok,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '调用 feishu_openapi_call 时发生未知错误';
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              status: 0,
              headers: {},
              error: {
                message,
              },
            }, null, 2),
          },
        ],
      };
    }
  },
};

import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@larksuiteoapi/node-sdk';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import pkg from '../package.json';
import type { ToolDefinition, FeishuContext } from 'feishu-tools';

import { FeishuHandler } from './feishu-handler';
import { Props, refreshUpstreamAuthToken } from './utils';
import { oapiHttpInstance } from './utils/http-instance';
import { allTools, mcpCoreTools } from './tools/tools_registry';
import {
  handleActionsTools,
  handleActionsCall,
  handleActionsHealthz,
  handleActionsAuth,
  handleActionsAuthCallback,
  handleActionsAuthStatus,
  handleActionsOAuthAuthorize,
  handleActionsOAuthToken,
  handleActionsOpenApi,
} from './actions/bridge';

const APP_VERSION = pkg.version;

type RuntimeEnv = Env & {
  ALLOWED_ORIGINS?: string;
};

const resolveAllowedOrigin = (request: Request, allowedOrigins?: string): string => {
  if (!allowedOrigins || allowedOrigins.trim() === '' || allowedOrigins.trim() === '*') {
    return '*';
  }

  const requestOrigin = request.headers.get('origin');
  if (!requestOrigin) {
    return '*';
  }

  const allowed = allowedOrigins.split(',').map((origin) => origin.trim()).filter(Boolean);
  return allowed.includes(requestOrigin) ? requestOrigin : allowed[0] || '*';
};

const applyCorsHeaders = (response: Response, request: Request, allowedOrigins?: string): Response => {
  const headers = new Headers(response.headers);
  if (!headers.has('Access-Control-Allow-Origin')) {
    headers.set('Access-Control-Allow-Origin', resolveAllowedOrigin(request, allowedOrigins));
  }
  headers.set('Vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const createOptionsResponse = (request: Request, allowedOrigins?: string): Response => {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', resolveAllowedOrigin(request, allowedOrigins));
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('Vary', 'Origin');
  return new Response(null, {
    status: 204,
    headers,
  });
};

const client = new Client({
  appId: env.FEISHU_APP_ID,
  appSecret: env.FEISHU_APP_SECRET,
  httpInstance: oapiHttpInstance,
});

// ── 精简描述：只保留 summary 部分 ──
function trimDescription(desc?: string): string {
  if (!desc) return '';
  // feishu-tools formatDescription 用 \n\n**适用于:** 分隔
  const cut = desc.indexOf('\n\n**适用于:**');
  if (cut !== -1) return desc.substring(0, cut);
  const cut2 = desc.indexOf('\n\n**不适用于:**');
  if (cut2 !== -1) return desc.substring(0, cut2);
  const cut3 = desc.indexOf('\n\n**使用指南:**');
  if (cut3 !== -1) return desc.substring(0, cut3);
  return desc;
}

// heading block_type 映射: level 1→blockType 3, level 2→blockType 4, ...
const HEADING_BLOCK_TYPES: Record<number, string> = {
  1: 'heading1', 2: 'heading2', 3: 'heading3',
  4: 'heading4', 5: 'heading5', 6: 'heading6',
  7: 'heading7', 8: 'heading8', 9: 'heading9',
};

/**
 * 精简版工具注册：
 * 1. 描述只保留 summary 部分
 * 2. 去掉 outputSchema（listTools 不需要）
 * 3. 合并 heading1-9 为一个 build_heading_block 工具
 */
function registerToolsLite(
  server: McpServer,
  tools: ToolDefinition[],
  context: FeishuContext,
) {
  const headingTools = tools.filter(t => /^build_heading\d_block$/.test(t.name));
  const otherTools = tools.filter(t => !/^build_heading\d_block$/.test(t.name));

  // 合并 heading1-9 为单个工具
  if (headingTools.length > 0) {
    const h1 = headingTools[0];
    server.registerTool(
      'build_heading_block',
      {
        description: '构建飞书文档标题块(h1-h9)。支持富文本格式（加粗、斜体、链接等）、@用户、@文档等元素。通过 level 参数指定标题级别。',
        inputSchema: {
          level: z.number().int().min(1).max(9).describe('标题级别 1-9'),
          ...(h1.inputSchema as Record<string, any>),
        },
      },
      (args: any, extra: any) => {
        const level = args.level || 1;
        const target = headingTools.find(t => t.name === `build_heading${level}_block`);
        if (!target) {
          return { content: [{ type: 'text' as const, text: `Invalid heading level: ${level}` }] };
        }
        const { level: _level, ...restArgs } = args;
        return target.callback(context, restArgs, extra);
      },
    );
  }

  // 注册其他工具（精简描述、去掉 outputSchema）
  for (const tool of otherTools) {
    server.registerTool(
      tool.name,
      {
        description: trimDescription(tool.description),
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      (args: any, extra: any) => tool.callback(context, args, extra),
    );
  }
}

export class MyMCP extends McpAgent<Props, Env> {
  server = new McpServer({
    name: 'Feishu OAuth Proxy Demo',
    version: '1.0.0',
  });

  async handler(params: unknown, customHandler: (p: unknown, c: Client, token: string) => Promise<unknown>) {
    return customHandler(params, client, this.props.accessToken);
  }

  async init() {
    const context: FeishuContext = {
      client,
      getUserAccessToken: () => this.props.accessToken as string,
    };

    registerToolsLite(this.server, mcpCoreTools, context);
  }
}

const oauthProvider = new OAuthProvider({
  apiHandlers: {
    '/mcp': MyMCP.serve('/mcp'),
    '/sse': MyMCP.serveSSE('/sse'),
  },
  defaultHandler: FeishuHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  tokenExchangeCallback: async (options) => {
    if (options.grantType === 'authorization_code') {
      return {
        accessTokenProps: options.props,
        accessTokenTTL: options.props.expiresIn,
      };
    }

    if (options.grantType === 'refresh_token') {
      const [accessToken, refreshToken, expiresIn, errResponse] = await refreshUpstreamAuthToken({
        refreshToken: options.props.refreshToken,
        upstream_url: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
        client_id: env.FEISHU_APP_ID,
        client_secret: env.FEISHU_APP_SECRET,
      });

      if (!errResponse) {
        return {
          newProps: {
            ...options.props,
            accessToken,
            refreshToken,
          },
          accessTokenTTL: expiresIn,
        };
      }
    }

    return undefined;
  },
});

export default {
  async fetch(request: Request, runtimeEnv: RuntimeEnv, executionContext: ExecutionContext): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return createOptionsResponse(request, runtimeEnv.ALLOWED_ORIGINS);
    }

    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      return new Response(JSON.stringify({
        status: 'ok',
        version: APP_VERSION,
        endpoints: {
          mcp: '/mcp',
          sse: '/sse',
          actions_tools: '/actions/tools',
          actions_call: '/actions/call',
        },
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': resolveAllowedOrigin(request, runtimeEnv.ALLOWED_ORIGINS),
          Vary: 'Origin',
        },
      });
    }

    // ── Actions Bridge ──
    const actionsEnv = {
      OAUTH_KV: runtimeEnv.OAUTH_KV,
      FEISHU_APP_ID: env.FEISHU_APP_ID,
      FEISHU_APP_SECRET: env.FEISHU_APP_SECRET,
      ACTIONS_OAUTH_CLIENT_ID: env.ACTIONS_OAUTH_CLIENT_ID,
      ACTIONS_OAUTH_CLIENT_SECRET: env.ACTIONS_OAUTH_CLIENT_SECRET,
    };
    const actionsOrigin = resolveAllowedOrigin(request, runtimeEnv.ALLOWED_ORIGINS);

    if (request.method === 'GET' && requestUrl.pathname === '/actions/auth') {
      return await handleActionsAuth(request, actionsEnv);
    }
    if (request.method === 'GET' && requestUrl.pathname === '/actions/auth/callback') {
      return handleActionsAuthCallback(request, actionsEnv, actionsOrigin);
    }
    if (request.method === 'GET' && requestUrl.pathname === '/actions/auth/status') {
      return handleActionsAuthStatus(actionsEnv, actionsOrigin);
    }
    if (request.method === 'GET' && requestUrl.pathname === '/actions/oauth/authorize') {
      return handleActionsOAuthAuthorize(request, actionsEnv);
    }
    if (request.method === 'POST' && requestUrl.pathname === '/actions/oauth/token') {
      return handleActionsOAuthToken(request, actionsEnv);
    }
    if (request.method === 'GET' && requestUrl.pathname === '/actions/tools') {
      return handleActionsTools(allTools, request, actionsOrigin);
    }
    if (request.method === 'POST' && requestUrl.pathname === '/actions/openapi') {
      return await handleActionsOpenApi(request, actionsEnv, actionsOrigin);
    }
    if (request.method === 'POST' && requestUrl.pathname === '/actions/call') {
      return handleActionsCall(request, allTools, client, actionsEnv, actionsOrigin);
    }
    if (request.method === 'GET' && requestUrl.pathname === '/actions/healthz') {
      return handleActionsHealthz(requestUrl.origin, request, actionsOrigin);
    }

    if (request.method === 'GET' && requestUrl.pathname === '/.well-known/mcp.json') {
      return new Response(JSON.stringify({
        endpoints: {
          mcp: '/mcp',
          sse: '/sse',
        },
        auth: {
          authorize: '/authorize',
          callback: '/callback',
          token: '/token',
        },
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': resolveAllowedOrigin(request, runtimeEnv.ALLOWED_ORIGINS),
          Vary: 'Origin',
        },
      });
    }

    const response = await oauthProvider.fetch(request, runtimeEnv, executionContext);
    if (requestUrl.pathname === '/mcp' || requestUrl.pathname === '/sse') {
      return applyCorsHeaders(response, request, runtimeEnv.ALLOWED_ORIGINS);
    }

    return response;
  },
};

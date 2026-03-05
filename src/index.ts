import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@larksuiteoapi/node-sdk';
import { env } from 'cloudflare:workers';
import pkg from '../package.json';
import type { FeishuContext } from 'feishu-tools';

import { FeishuHandler } from './feishu-handler';
import { Props, refreshUpstreamAuthToken } from './utils';
import { oapiHttpInstance } from './utils/http-instance';
import { allTools, mcpCoreTools } from './tools/tools_registry';
import { registerToolsLite } from './register-tools';
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

// registerToolsLite 已提取到 src/register-tools.ts，云端和本地共用

export class MyMCP extends McpAgent<Props, Env> {
  server = new McpServer({
    name: 'Feishu OAuth Proxy Demo',
    version: '1.0.0',
  });

  // ── 可变 token 缓存，用于自动刷新 ──
  private _tokenCache: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // unix ms
  } | null = null;

  private _refreshPromise: Promise<string> | null = null;

  /**
   * 获取有效的 access_token：
   * - 检查是否即将过期（提前 5 分钟刷新）
   * - 如果 this.props 被外部 OAuth 刷新更新了，同步使用最新值
   * - 过期时自动用 refresh_token 换取新 token
   */
  private async getValidAccessToken(): Promise<string> {
    const props = this.props as unknown as Props;

    // 初始化缓存（首次调用）
    if (!this._tokenCache) {
      this._tokenCache = {
        accessToken: props.accessToken,
        refreshToken: props.refreshToken,
        // 如果没有 expiresIn，默认假设 2 小时有效期
        expiresAt: Date.now() + (props.expiresIn || 7200) * 1000,
      };
    }

    // 如果 this.props.accessToken 被 OAuth 层刷新了（值不同），同步过来
    if (props.accessToken !== this._tokenCache.accessToken) {
      this._tokenCache = {
        accessToken: props.accessToken,
        refreshToken: props.refreshToken,
        expiresAt: Date.now() + (props.expiresIn || 7200) * 1000,
      };
    }

    // 还没到刷新时间（提前 5 分钟），直接用
    if (Date.now() < this._tokenCache.expiresAt - 5 * 60 * 1000) {
      return this._tokenCache.accessToken;
    }

    // 需要刷新 — 避免并发重复刷新
    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    this._refreshPromise = this._doRefresh();
    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  private async _doRefresh(): Promise<string> {
    const cache = this._tokenCache!;
    console.log('[MyMCP] Token 即将过期，自动刷新中...');

    const result = await refreshUpstreamAuthToken({
      refreshToken: cache.refreshToken,
      upstream_url: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
      client_id: env.FEISHU_APP_ID,
      client_secret: env.FEISHU_APP_SECRET,
    });

    // result: [accessToken, refreshToken, expiresIn, null] | [null, Response]
    const accessToken = result[0] as string | null;
    if (!accessToken) {
      console.error('[MyMCP] Token 刷新失败，继续使用旧 token');
      return cache.accessToken;
    }

    const newRefreshToken = result[1] as string;
    const expiresIn = result[2] as number;

    console.log('[MyMCP] Token 刷新成功，有效期', expiresIn, '秒');
    this._tokenCache = {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt: Date.now() + (expiresIn || 7200) * 1000,
    };

    // 同步更新 this.props 以保持一致性
    (this.props as any).accessToken = accessToken;
    (this.props as any).refreshToken = newRefreshToken;

    return accessToken;
  }

  async handler(params: unknown, customHandler: (p: unknown, c: Client, token: string) => Promise<unknown>) {
    const token = await this.getValidAccessToken();
    return customHandler(params, client, token);
  }

  async init() {
    const context: FeishuContext = {
      client,
      getUserAccessToken: () => this.getValidAccessToken(),
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

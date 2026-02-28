import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@larksuiteoapi/node-sdk';
import { env } from 'cloudflare:workers';
import pkg from '../package.json';
import {
  registerTools,
  // authen
  getUserInfo,
  // docx
  createDocument,
  getDocument,
  getDocumentRawContent,
  convertContentToBlocks,
  // docx blocks
  listDocumentBlocks,
  createBlocks,
  deleteBlock,
  batchDeleteBlocks,
  buildTextBlock,
  buildHeading1Block,
  buildHeading2Block,
  buildHeading3Block,
  buildHeading4Block,
  buildHeading5Block,
  buildHeading6Block,
  buildHeading7Block,
  buildHeading8Block,
  buildHeading9Block,
  buildBulletBlock,
  buildOrderedBlock,
  buildQuoteBlock,
  buildEquationBlock,
  buildTodoBlock,
  buildCodeBlock,
  buildDividerBlock,
  buildCalloutBlock,
  searchFeishuCalloutEmoji,
  createFileBlock,
  createImageBlock,
  buildIframeBlock,
  buildChatCardBlock,
  buildGridBlock,
  buildMermaidBlock,
  buildGlossaryBlock,
  buildTimelineBlock,
  buildCatalogNavigationBlock,
  buildInformationCollectionBlock,
  buildCountdownBlock,
  // drive
  listFileComments,
  // sheets
  addSheet,
  copySheet,
  createSpreadsheet,
  deleteSheet,
  getSheet,
  getSpreadsheet,
  querySheets,
  updateSheetMetadata,
  updateSheetProtection,
  updateSheetViewSettings,
  updateSpreadsheet,
} from 'feishu-tools';

import { FeishuHandler } from './feishu-handler';
import { Props, refreshUpstreamAuthToken } from './utils';
import { oapiHttpInstance } from './utils/http-instance';
import { feishuOpenApiCall } from './tools/openapi';

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

export class MyMCP extends McpAgent<Props, Env> {
  server = new McpServer({
    name: 'Feishu OAuth Proxy Demo',
    version: '1.0.0',
  });

  async handler(params: unknown, customHandler: (p: unknown, c: Client, token: string) => Promise<unknown>) {
    return customHandler(params, client, this.props.accessToken);
  }

  async init() {
    const context = {
      client,
      getUserAccessToken: () => this.props.accessToken as string,
    };

    const allTools = [
      getUserInfo,
      createDocument,
      getDocument,
      getDocumentRawContent,
      convertContentToBlocks,
      listDocumentBlocks,
      createBlocks,
      deleteBlock,
      batchDeleteBlocks,
      buildTextBlock,
      buildHeading1Block,
      buildHeading2Block,
      buildHeading3Block,
      buildHeading4Block,
      buildHeading5Block,
      buildHeading6Block,
      buildHeading7Block,
      buildHeading8Block,
      buildHeading9Block,
      buildBulletBlock,
      buildOrderedBlock,
      buildQuoteBlock,
      buildEquationBlock,
      buildTodoBlock,
      buildCodeBlock,
      buildDividerBlock,
      buildCalloutBlock,
      searchFeishuCalloutEmoji,
      createFileBlock,
      createImageBlock,
      buildIframeBlock,
      buildChatCardBlock,
      buildGridBlock,
      buildMermaidBlock,
      buildGlossaryBlock,
      buildTimelineBlock,
      buildCatalogNavigationBlock,
      buildInformationCollectionBlock,
      buildCountdownBlock,
      listFileComments,
      addSheet,
      copySheet,
      createSpreadsheet,
      deleteSheet,
      getSheet,
      getSpreadsheet,
      querySheets,
      updateSheetMetadata,
      updateSheetProtection,
      updateSheetViewSettings,
      updateSpreadsheet,
      feishuOpenApiCall,
    ];

    registerTools(this.server, allTools, context);
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

import type { ToolDefinition, FeishuContext } from 'feishu-tools';
import type { Client } from '@larksuiteoapi/node-sdk';
import {
  getUpstreamAuthorizeUrl,
  fetchUpstreamAuthToken,
  refreshUpstreamAuthToken,
} from '../utils';

/**
 * Actions Bridge — 把 MCP tools 以普通 REST API 形式暴露出来。
 *
 * Endpoints:
 *   GET  /actions/tools                列出所有工具（支持 brief/full、分页、搜索）
 *   POST /actions/call                 调用工具（自动管理 token）
 *   GET  /actions/healthz              健康检查
 *   GET  /actions/auth                 发起飞书 OAuth 授权（支持 next 参数）
 *   GET  /actions/auth/callback        飞书回调，存 token 到 KV
 *   GET  /actions/auth/status          查看 token 状态
 *   GET  /actions/oauth/authorize      OpenAI Actions OAuth authorize
 *   POST /actions/oauth/token          OpenAI Actions OAuth token
 */

// ── KV Token 管理（多用户） ──

const KV_TOKEN_KEY_PREFIX = 'actions:user_token';
const KV_TOKEN_KEY_LEGACY = 'actions:user_token'; // 兼容旧的单用户 key

interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix timestamp (ms)
  userId: string;
  name?: string;
  email?: string;
}

interface ActionsEnv {
  OAUTH_KV: KVNamespace;
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  ACTIONS_OAUTH_CLIENT_ID?: string;
  ACTIONS_OAUTH_CLIENT_SECRET?: string;
}

function tokenKeyForUser(userKey: string): string {
  return `${KV_TOKEN_KEY_PREFIX}:${userKey}`;
}

async function getStoredToken(kv: KVNamespace, userKey?: string): Promise<StoredToken | null> {
  // 优先用 per-user key
  if (userKey) {
    const perUser = await kv.get(tokenKeyForUser(userKey));
    if (perUser) return JSON.parse(perUser) as StoredToken;
  }
  // 回退到 legacy 单用户 key
  const legacy = await kv.get(KV_TOKEN_KEY_LEGACY);
  return legacy ? (JSON.parse(legacy) as StoredToken) : null;
}

async function saveToken(kv: KVNamespace, token: StoredToken, userKey?: string): Promise<void> {
  const key = tokenKeyForUser(userKey ?? token.userId);
  await kv.put(key, JSON.stringify(token));
  // 同时写 legacy key 保持向后兼容
  await kv.put(KV_TOKEN_KEY_LEGACY, JSON.stringify(token));
}

// ── OpenAI Actions OAuth：通过 Bearer token 找到 userKey ──

interface OaiAccessRecord {
  userKey: string;
  scope?: string;
}

function getBearer(req: Request): string | null {
  const auth = req.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function resolveUserKeyFromOaiToken(kv: KVNamespace, req: Request): Promise<string | null> {
  const oaiToken = getBearer(req);
  if (!oaiToken) return null;
  const recRaw = await kv.get(`OAI_AT::${oaiToken}`);
  if (!recRaw) return null;
  const rec = JSON.parse(recRaw) as OaiAccessRecord;
  return rec?.userKey || null;
}

/**
 * 获取可用的 access_token（多用户版）：
 * 1. 通过 OpenAI Actions OAuth Bearer token 找到 userKey
 * 2. 回退：直接用 Bearer token 作为飞书 token（兼容手动传入）
 * 3. 回退：从 legacy KV 读取（兼容旧的单用户模式）
 * 4. 如果已过期，自动用 refresh_token 刷新并回写 KV
 */
async function resolveAccessToken(
  request: Request,
  env: ActionsEnv,
): Promise<{ token: string; error?: never } | { token?: never; error: string }> {
  const kv = env.OAUTH_KV;

  // 尝试通过 OpenAI Actions OAuth token 找到 userKey
  const userKey = await resolveUserKeyFromOaiToken(kv, request);

  // 如果找到了 userKey，从 per-user KV 取飞书 token
  if (userKey) {
    const stored = await getStoredToken(kv, userKey);
    if (!stored) {
      return { error: '该用户尚未关联飞书账号。请先完成飞书授权。' };
    }
    return resolveAndRefresh(stored, kv, env, userKey);
  }

  // 回退：看 header 里是不是直接传了飞书 token
  const bearer = getBearer(request);
  if (bearer) {
    // 检查是不是 OpenAI 发的（已查过不是），直接当飞书 token 用
    return { token: bearer };
  }

  // 回退：legacy 单用户模式
  const stored = await getStoredToken(kv);
  if (!stored) {
    return { error: '尚未授权。请先访问 /actions/auth 完成飞书登录授权。' };
  }
  return resolveAndRefresh(stored, kv, env);
}

async function resolveAndRefresh(
  stored: StoredToken,
  kv: KVNamespace,
  env: ActionsEnv,
  userKey?: string,
): Promise<{ token: string; error?: never } | { token?: never; error: string }> {
  // 未过期，直接用（提前 5 分钟刷新）
  if (Date.now() < stored.expiresAt - 5 * 60 * 1000) {
    return { token: stored.accessToken };
  }

  // 过期了，自动刷新
  const [accessToken, refreshToken, expiresIn, errResp] = await refreshUpstreamAuthToken({
    refreshToken: stored.refreshToken,
    upstream_url: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    client_id: env.FEISHU_APP_ID,
    client_secret: env.FEISHU_APP_SECRET,
  });

  if (errResp) {
    return { error: 'Token 刷新失败，请重新访问 /actions/auth 授权。' };
  }

  const updated: StoredToken = {
    ...stored,
    accessToken: accessToken!,
    refreshToken: refreshToken!,
    expiresAt: Date.now() + expiresIn! * 1000,
  };
  await saveToken(kv, updated, userKey);

  return { token: accessToken! };
}

// ── 飞书 Auth 端点 ──

// OAuth scope：空格分隔，包含 offline_access 以支持 refresh_token
// 若飞书提示某项 scope 无效，去应用后台申请/开通或从此处移除
const FEISHU_SCOPE = [
  'offline_access',

  // Contacts / user info
  'contact:user.base:readonly',
  'contact:contact:readonly',

  // IM (bot/messages)
  'im:message',
  'im:message:readonly',
  'im:chat',
  'im:chat:readonly',

  // Drive / Docs / Sheets
  'drive:drive',
  'drive:drive:readonly',
  'drive:file',
  'drive:file:readonly',

  // Wiki
  'wiki:space',
  'wiki:space:readonly',
  'wiki:node',
  'wiki:node:readonly',

  // Bitable / Base (多维表格)
  'bitable:app',
  'bitable:app:readonly',
  'bitable:record:write',
  'bitable:record:readonly',
  'base:field:read',
  'base:record:write',
  'base:record:read',

  // Tasks
  'task:task',
  'task:task:readonly',
].join(' ');

const ACTIONS_NEXT_PREFIX = 'ACTIONS_NEXT::';

function randState(len = 40): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export async function handleActionsAuth(request: Request, env: ActionsEnv) {
  const url = new URL(request.url);
  const next = url.searchParams.get('next') || '';

  // IMPORTANT: redirect_uri 保持固定（无 query），否则飞书 token exchange 会因 redirect_uri 不一致而失败
  const callbackUrl = new URL('/actions/auth/callback', request.url);

  // 用 OAuth state + KV 暂存 next，避免 redirect_uri 被污染
  const state = randState(40);
  if (next) {
    await env.OAUTH_KV.put(ACTIONS_NEXT_PREFIX + state, next, { expirationTtl: 600 });
  }

  const authorizeUrl = getUpstreamAuthorizeUrl({
    upstream_url: 'https://open.feishu.cn/open-apis/authen/v1/authorize',
    client_id: env.FEISHU_APP_ID,
    redirect_uri: callbackUrl.href,
    // scope 与官方 feishu-mcp-server 一致（已验证可用）
    scope: 'wiki:wiki wiki:wiki:readonly wiki:node:read drive:drive drive:file drive:file:upload auth:user.id:read offline_access task:task:read docs:document:import docs:document.media:upload docx:document docx:document:readonly docx:document.block:convert',
    state,
  });
  return Response.redirect(authorizeUrl, 302);
}

export async function handleActionsAuthCallback(
  request: Request,
  env: ActionsEnv,
  origin = '*',
) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) {
    return json({ ok: false, error: '缺少 code 参数' }, 400, origin);
  }

  // 从 KV 读取 next（通过 state 映射），然后清理
  const state = url.searchParams.get('state') || '';
  const next = state ? await env.OAUTH_KV.get(ACTIONS_NEXT_PREFIX + state) : null;
  if (state) await env.OAUTH_KV.delete(ACTIONS_NEXT_PREFIX + state);

  // redirect_uri 保持干净（和 handleActionsAuth 发起时一致）
  const callbackUrl = new URL('/actions/auth/callback', request.url);

  const result = await fetchUpstreamAuthToken({
    upstream_url: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    client_id: env.FEISHU_APP_ID,
    client_secret: env.FEISHU_APP_SECRET,
    code,
    redirect_uri: callbackUrl.href,
  });

  if (result[result.length - 1] !== null) {
    return json({ ok: false, error: '换取 token 失败' }, 500, origin);
  }

  const [accessToken, refreshToken, expiresIn] = result as [string, string, number, null];

  // 获取用户信息
  let userId = '';
  let name = '';
  let email = '';
  try {
    const userResp = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
    const userData = (await userResp.json()) as any;
    userId = userData?.data?.user_id || '';
    name = userData?.data?.name || userData?.data?.en_name || '';
    email = userData?.data?.email || '';
  } catch { /* 用户信息获取失败不影响主流程 */ }

  // 存入 KV（per-user + legacy）
  const token: StoredToken = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    userId,
    name,
    email,
  };
  await saveToken(env.OAUTH_KV, token, userId);

  // 如果有 next 参数，redirect 回去（OpenAI Actions OAuth C2 flow）
  if (next) {
    const back = new URL(next);
    back.searchParams.set('linked', '1');
    back.searchParams.set('userKey', userId);
    return Response.redirect(back.toString(), 302);
  }

  // 无 next：返回成功页面（直接扫码场景）
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>授权成功</title></head>
<body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center">
<h1>✅ 飞书授权成功</h1>
<p>用户：<strong>${name || userId}</strong></p>
<p>Token 已存储，后续调用 <code>/actions/call</code> 无需再传 Bearer token。</p>
<p>Token 将自动续期，无需重复扫码。</p>
<p style="margin-top:40px;color:#888">可以关闭此页面了。</p>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function handleActionsAuthStatus(env: ActionsEnv, origin = '*') {
  const stored = await getStoredToken(env.OAUTH_KV);
  if (!stored) {
    return json({
      ok: true,
      authorized: false,
      message: '尚未授权，请访问 /actions/auth 完成飞书登录。',
    }, 200, origin);
  }

  const now = Date.now();
  const expiresIn = Math.max(0, Math.floor((stored.expiresAt - now) / 1000));
  const isExpired = now >= stored.expiresAt;

  return json({
    ok: true,
    authorized: true,
    user: { userId: stored.userId, name: stored.name, email: stored.email },
    token: {
      expiresIn: `${expiresIn}s`,
      expired: isExpired,
      willAutoRefresh: true,
    },
  }, 200, origin);
}

// ── OpenAI Actions OAuth 端点 ──

function randToken(len = 48): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function sha256base64url(str: string): Promise<string> {
  const enc = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  const arr = new Uint8Array(digest);
  let binary = '';
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * OpenAI Actions OAuth authorize 端点。
 * 如果用户还没关联飞书，先 redirect 到 /actions/auth?next=<当前 URL>
 * 飞书授权完成后 callback 带 linked=1&userKey=ou_xxx 回来，继续签发 code。
 */
export async function handleActionsOAuthAuthorize(request: Request, env: ActionsEnv) {
  const url = new URL(request.url);
  const clientId = (url.searchParams.get('client_id') || env.ACTIONS_OAUTH_CLIENT_ID || '').trim();
  const redirectUri = url.searchParams.get('redirect_uri') || '';
  const responseType = url.searchParams.get('response_type') || '';
  const scope = url.searchParams.get('scope') || 'tools';
  const state = url.searchParams.get('state') || '';
  const codeChallenge = url.searchParams.get('code_challenge') || '';
  const codeChallengeMethod = (url.searchParams.get('code_challenge_method') || '').toUpperCase();

  if (responseType !== 'code') {
    return new Response('unsupported response_type', { status: 400 });
  }
  if (!clientId || !redirectUri) {
    return new Response('missing client_id or redirect_uri', { status: 400 });
  }

  // 检查是否已完成飞书关联
  const linked = url.searchParams.get('linked') === '1';
  const userKey = url.searchParams.get('userKey') || '';

  if (!linked || !userKey) {
    // 还没关联飞书，redirect 到飞书 auth，完成后回到当前 URL
    const thisUrl = url.toString();
    const authUrl = new URL('/actions/auth', request.url);
    authUrl.searchParams.set('next', thisUrl);
    return Response.redirect(authUrl.toString(), 302);
  }

  // 飞书已关联，签发 authorization code
  const code = randToken(40);
  const rec = {
    userKey,
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    issued_at: Date.now(),
  };
  await env.OAUTH_KV.put(`OAI_CODE::${code}`, JSON.stringify(rec), { expirationTtl: 300 });

  // redirect 回 OpenAI 的 redirect_uri
  const cb = new URL(redirectUri);
  cb.searchParams.set('code', code);
  if (state) cb.searchParams.set('state', state);
  return Response.redirect(cb.toString(), 302);
}

/**
 * OpenAI Actions OAuth token 端点。
 * 支持 authorization_code 和 refresh_token grant types。
 */
export async function handleActionsOAuthToken(request: Request, env: ActionsEnv) {
  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/x-www-form-urlencoded')) {
    return new Response(JSON.stringify({ error: 'invalid_request', error_description: 'expected application/x-www-form-urlencoded' }), {
      status: 415,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const bodyText = await request.text();
  const params = new URLSearchParams(bodyText);
  const grantType = params.get('grant_type') || '';

  if (grantType === 'authorization_code') {
    const code = params.get('code') || '';
    const redirectUri = params.get('redirect_uri') || '';
    const codeVerifier = params.get('code_verifier') || '';

    const recRaw = await env.OAUTH_KV.get(`OAI_CODE::${code}`);
    if (!recRaw) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const rec = JSON.parse(recRaw) as any;

    if (rec.redirect_uri !== redirectUri) {
      return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // PKCE 验证
    if (rec.code_challenge && rec.code_challenge_method === 'S256') {
      const computed = await sha256base64url(codeVerifier);
      if (computed !== rec.code_challenge) {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // 删除已用的 code
    await env.OAUTH_KV.delete(`OAI_CODE::${code}`);

    // 签发 access_token + refresh_token
    const accessToken = randToken(48);
    const refreshToken = randToken(48);
    const tokenData = JSON.stringify({ userKey: rec.userKey, scope: rec.scope });
    await env.OAUTH_KV.put(`OAI_AT::${accessToken}`, tokenData, { expirationTtl: 3600 });
    await env.OAUTH_KV.put(`OAI_RT::${refreshToken}`, tokenData, { expirationTtl: 2592000 }); // 30 天

    return new Response(JSON.stringify({
      token_type: 'Bearer',
      access_token: accessToken,
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: rec.scope || 'tools',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (grantType === 'refresh_token') {
    const rt = params.get('refresh_token') || '';
    const recRaw = await env.OAUTH_KV.get(`OAI_RT::${rt}`);
    if (!recRaw) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const rec = JSON.parse(recRaw) as OaiAccessRecord;

    // 签发新的 access_token
    const accessToken = randToken(48);
    await env.OAUTH_KV.put(`OAI_AT::${accessToken}`, JSON.stringify({ userKey: rec.userKey, scope: rec.scope }), { expirationTtl: 3600 });

    return new Response(JSON.stringify({
      token_type: 'Bearer',
      access_token: accessToken,
      expires_in: 3600,
      refresh_token: rt, // 复用同一个 refresh_token
      scope: rec.scope || 'tools',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'unsupported_grant_type' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

// ── helpers ──

function withCors(resp: Response, origin = '*') {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Vary', 'Origin');
  return new Response(resp.body, { status: resp.status, headers: h });
}

function json(data: unknown, status = 200, origin = '*') {
  return withCors(
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
    origin,
  );
}

/**
 * feishu-tools 导出的 inputSchema 是自定义序列化格式（非 Zod 实例、非 JSON Schema）。
 * 每个字段有 { type, def, ... } 结构，需要手动转换为标准 JSON Schema。
 */
function fieldToJsonSchema(field: any): any {
  if (!field) return {};
  const t = field.type;

  switch (t) {
    case 'string': {
      const s: any = { type: 'string' };
      if (field.minLength != null) s.minLength = field.minLength;
      if (field.maxLength != null) s.maxLength = field.maxLength;
      if (field.description) s.description = field.description;
      return s;
    }
    case 'number': {
      const s: any = field.isInt ? { type: 'integer' } : { type: 'number' };
      if (field.minValue != null && isFinite(field.minValue)) s.minimum = field.minValue;
      if (field.maxValue != null && isFinite(field.maxValue)) s.maximum = field.maxValue;
      if (field.description) s.description = field.description;
      return s;
    }
    case 'boolean':
      return { type: 'boolean' };
    case 'enum':
      return { type: 'string', enum: field.options || Object.values(field.enum || {}) };
    case 'optional':
      return fieldToJsonSchema(field.def?.innerType);
    case 'nullable': {
      const inner = fieldToJsonSchema(field.def?.innerType);
      return { anyOf: [inner, { type: 'null' }] };
    }
    case 'default': {
      const inner = fieldToJsonSchema(field.def?.innerType);
      return { ...inner, default: field.def?.defaultValue };
    }
    case 'array': {
      const items = field.def?.element ? fieldToJsonSchema(field.def.element) : {};
      return { type: 'array', items };
    }
    case 'object': {
      const shape = field.def?.shape;
      if (shape && typeof shape === 'object') return shapeToJsonSchema(shape);
      return { type: 'object' };
    }
    case 'record': {
      const valSchema = field.def?.valueType ? fieldToJsonSchema(field.def.valueType) : {};
      return { type: 'object', additionalProperties: valSchema };
    }
    case 'union': {
      const opts = (field.def?.options || []).map((o: any) => fieldToJsonSchema(o));
      return opts.length === 1 ? opts[0] : { anyOf: opts };
    }
    case 'any':
      return {};
    default:
      return {};
  }
}

function shapeToJsonSchema(shape: Record<string, any>): any {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    const f = field as any;
    const isOptional = f?.type === 'optional' || f?.type === 'default';
    properties[key] = fieldToJsonSchema(f);
    if (!isOptional) required.push(key);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function inputSchemaToJsonSchema(inputSchema: Record<string, any>) {
  try {
    const entries = Object.entries(inputSchema || {});
    if (entries.length === 0) return { type: 'object', properties: {} };
    return shapeToJsonSchema(inputSchema);
  } catch {
    return { type: 'object', properties: Object.fromEntries(Object.keys(inputSchema || {}).map(k => [k, {}])) };
  }
}

// ── handlers ──

/**
 * GET /actions/tools — 列出工具
 * 查询参数：
 *   view=brief|full  (默认 brief，只返回 name + descriptionShort)
 *   q=关键词          (按 name/description 搜索)
 *   limit=N           (每页数量，默认 100)
 *   cursor=name       (分页游标，返回 name > cursor 的工具)
 */
export function handleActionsTools(
  tools: ToolDefinition[],
  request: Request,
  origin = '*',
) {
  const url = new URL(request.url);
  const view = (url.searchParams.get('view') || 'brief').toLowerCase();
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const limitRaw = url.searchParams.get('limit');
  const limit = Math.max(1, Math.min(200, limitRaw ? Number(limitRaw) : 100));
  const cursor = url.searchParams.get('cursor') || '';

  let sorted = [...tools].sort((a, b) => String(a.name).localeCompare(String(b.name)));

  // 搜索过滤
  if (q) {
    sorted = sorted.filter(t => {
      const name = String(t.name || '').toLowerCase();
      const desc = String(t.description || '').toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  }

  // 游标分页
  if (cursor) {
    sorted = sorted.filter(t => String(t.name) > cursor);
  }

  const page = sorted.slice(0, limit);
  const nextCursor = page.length === limit && sorted.length > limit ? String(page[page.length - 1].name) : null;

  const payloadTools = page.map(t => {
    if (view === 'full') {
      return {
        name: t.name,
        description: t.description ?? '',
        inputSchema: inputSchemaToJsonSchema(t.inputSchema as Record<string, any>),
      };
    }
    // brief 模式：只返回名字和截断描述
    const short = (t.description || '').slice(0, 180);
    return { name: t.name, descriptionShort: short };
  });

  const payload = {
    ok: true,
    view: view === 'full' ? 'full' : 'brief',
    total: payloadTools.length,
    nextCursor,
    tools: payloadTools,
  };
  return json(payload, 200, origin);
}

export async function handleActionsCall(
  request: Request,
  tools: ToolDefinition[],
  client: Client,
  env: ActionsEnv,
  origin = '*',
) {
  // 验证 Content-Type
  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return json({ ok: false, error: 'Content-Type must be application/json' }, 415, origin);
  }

  // 解析请求体
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.tool !== 'string') {
    return json({ ok: false, error: 'Body must be { tool: string, args?: object }' }, 400, origin);
  }

  // 归一化 args：同时兼容两种入参格式
  //   A) 标准格式：{ tool: "xxx", args: { key: value } }
  //   B) ChatGPT 展开形态：{ tool: "xxx", method: "GET", path: "/..." }（args 散落在顶层）
  const toolName = body.tool as string;
  let args: Record<string, unknown>;
  if (body.args && typeof body.args === 'object' && !Array.isArray(body.args)) {
    // 标准格式：args 是一个对象
    args = body.args as Record<string, unknown>;
  } else {
    // 展开形态：把 tool 和 args 以外的所有顶层字段收集为 args
    const { tool: _t, args: _a, ...rest } = body;
    args = Object.keys(rest).length > 0 ? rest : {};
  }

  // ── feishu_openapi_call：内置实现，跳过 tools_registry，彻底避免参数传递问题 ──
  if (toolName === 'feishu_openapi_call') {
    // 顶层字段兜底：ChatGPT 展开形态可能把 method/path 放在 body 顶层
    for (const k of ['method', 'path', 'query', 'headers', 'body'] as const) {
      if (args[k] === undefined && body[k] !== undefined) args[k] = body[k];
    }

    // 最后防线：从 URL query params 兜底（某些平台可能通过 query 传参）
    if (args.path == null) {
      try {
        const reqUrl = new URL(request.url);
        if (reqUrl.searchParams.get('path')) args.path = reqUrl.searchParams.get('path')!;
        if (reqUrl.searchParams.get('method')) args.method = reqUrl.searchParams.get('method')!;
      } catch { /* ignore */ }
    }

    // 终极兜底：扫描 body 所有值找 path 模式（/xxx/v1/yyy）
    if (args.path == null && body) {
      for (const v of Object.values(body)) {
        if (typeof v === 'string' && /^\/[a-z]/.test(v) && v !== toolName) {
          args.path = v;
          break;
        }
      }
    }

    const method = ((args.method as string) ?? 'GET').toString().toUpperCase();
    const rawPath = ((args.path as string) ?? '').toString();

    if (!rawPath) {
      // 返回详细诊断信息，方便排查到底收到了什么
      return json({
        ok: false,
        error: '缺少 path 参数，请提供飞书 OpenAPI 路径（如 /im/v1/messages）。',
        debug: { receivedArgs: args, receivedBody: body },
      }, 400, origin);
    }

    // 规范化 path：确保 /open-apis/ 前缀
    let normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    if (!normalizedPath.startsWith('/open-apis/') && normalizedPath !== '/open-apis') {
      normalizedPath = `/open-apis${normalizedPath}`;
    }

    // 获取 token
    const tokenResult = await resolveAccessToken(request, env);
    if (tokenResult.error) {
      return json({ ok: false, error: tokenResult.error }, 401, origin);
    }

    // 构建请求
    const url = new URL(normalizedPath, 'https://open.feishu.cn');
    if (args.query && typeof args.query === 'object') {
      for (const [k, v] of Object.entries(args.query as Record<string, unknown>)) {
        if (v != null) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokenResult.token}`,
    };
    if (args.headers && typeof args.headers === 'object') {
      for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
        if (k && k.toLowerCase() !== 'authorization') {
          headers[k] = String(v);
        }
      }
    }

    let fetchBody: string | undefined;
    if (method !== 'GET' && method !== 'HEAD' && args.body !== undefined) {
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
      }
      fetchBody = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
    }

    try {
      const resp = await fetch(url.toString(), { method, headers, body: fetchBody });
      const respText = await resp.text();
      const ct = resp.headers.get('content-type') || '';
      let parsed: unknown = respText;
      try { parsed = JSON.parse(respText); } catch { /* 非 JSON 就保留原文 */ }

      // 规范化输出：飞书典型格式 { code, data, msg }
      const parsedObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;

      if (resp.ok) {
        // 飞书成功响应通常有 data 字段，直接提取为 result
        const result = parsedObj && 'data' in parsedObj ? parsedObj.data : parsed;
        return json({ ok: true, status: resp.status, result, feishu: parsed }, 200, origin);
      }
      return json({ ok: false, status: resp.status, error: parsed || respText, feishu: parsed }, resp.status, origin);
    } catch (e: any) {
      return json({ ok: false, error: e?.message || String(e) }, 500, origin);
    }
  }

  // ── 其他工具：走 tools_registry ──
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    return json({ ok: false, error: `Unknown tool: ${toolName}` }, 404, origin);
  }

  // 自动获取 token（多用户 → 手动 Bearer → legacy）
  const tokenResult = await resolveAccessToken(request, env);
  if (tokenResult.error) {
    return json({ ok: false, error: tokenResult.error }, 401, origin);
  }

  // 构建 FeishuContext
  const context: FeishuContext = {
    client,
    getUserAccessToken: () => tokenResult.token,
  };

  try {
    const result = await tool.callback(context, args, {} as any);
    return json({ ok: true, result }, 200, origin);
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) }, 500, origin);
  }
}

export function handleActionsHealthz(
  baseUrl: string,
  request: Request,
  origin = '*',
) {
  const payload = {
    ok: true,
    status: 'ok',
    endpoints: {
      actions_tools: `${baseUrl}/actions/tools`,
      actions_call: `${baseUrl}/actions/call`,
      actions_openapi: `${baseUrl}/actions/openapi`,
      actions_auth: `${baseUrl}/actions/auth`,
      actions_oauth_authorize: `${baseUrl}/actions/oauth/authorize`,
      actions_oauth_token: `${baseUrl}/actions/oauth/token`,
      mcp: `${baseUrl}/mcp`,
      sse: `${baseUrl}/sse`,
    },
  };
  return json(payload, 200, origin);
}

// ── 路径纠错引擎：版本无关，按服务名映射 ──
function correctFeishuPath(path: string): string {
  // 服务名别名 → [正确服务名, 正确版本号]
  const SERVICE_ALIASES: Record<string, [string, string]> = {
    // 文档：doc/docs/document/documents → docx v1
    doc: ['docx', 'v1'], docs: ['docx', 'v1'], document: ['docx', 'v1'], documents: ['docx', 'v1'],
    // 知识库：knowledge → wiki v2
    knowledge: ['wiki', 'v2'],
    // 消息：messages/message/chat → im v1
    messages: ['im', 'v1'], message: ['im', 'v1'], chat: ['im', 'v1'],
    // 表格：spreadsheet/spreadsheets/sheet → sheets v3 (v2 for values)
    spreadsheet: ['sheets', 'v3'], spreadsheets: ['sheets', 'v3'], sheet: ['sheets', 'v3'],
    // 多维表格：base/table/tables → bitable v1
    base: ['bitable', 'v1'], table: ['bitable', 'v1'], tables: ['bitable', 'v1'],
    // 任务：tasks/todo/todos → task v2
    tasks: ['task', 'v2'], todo: ['task', 'v2'], todos: ['task', 'v2'],
    // 用户：contact/user/users/account/auth → authen v1
    contact: ['authen', 'v1'], user: ['authen', 'v1'], users: ['authen', 'v1'],
    account: ['authen', 'v1'], auth: ['authen', 'v1'],
  };

  // 动作别名 → 正确的资源路径后缀（GPT 常用 /create 而非正确的资源名）
  const ACTION_TO_RESOURCE: Record<string, Record<string, string>> = {
    docx: { create: 'documents' },
    im: { send: 'messages' },
    sheets: { create: 'spreadsheets' },
    bitable: { create: 'apps' },
    task: { create: 'tasks' },
  };

  // 特殊精确匹配（无法通过服务名正则处理的路径）
  const EXACT: Record<string, string> = {
    '/open-apis/v1/account/info': '/open-apis/authen/v1/user_info',
    '/open-apis/v1/user/info': '/open-apis/authen/v1/user_info',
    '/open-apis/me': '/open-apis/authen/v1/user_info',
    '/open-apis/spaces': '/open-apis/wiki/v2/spaces',
    '/open-apis/chats': '/open-apis/im/v1/chats',
  };

  if (EXACT[path]) return EXACT[path];

  let service: string | undefined;
  let rest: string;

  // 模式1：/open-apis/{service}/v{N}/{rest}  （标准格式，如 /doc/v2/create）
  const match1 = path.match(/^\/open-apis\/([^/]+)\/v\d+\/(.*)$/);
  // 模式2：/open-apis/v{N}/{service}/{rest}  （版本在前，如 /v2/docs）
  const match2 = path.match(/^\/open-apis\/v\d+\/([^/]+)(?:\/(.*))?$/);
  // 模式3：/open-apis/{service}/{rest}        （无版本号，如 /docs/create）
  const match3 = path.match(/^\/open-apis\/([^/]+)(?:\/(.*))?$/);

  if (match1) {
    service = match1[1];
    rest = match1[2] || '';
  } else if (match2) {
    service = match2[1];
    rest = match2[2] || '';
  } else if (match3 && SERVICE_ALIASES[match3[1]]) {
    service = match3[1];
    rest = match3[2] || '';
  } else {
    return path;
  }

  const alias = SERVICE_ALIASES[service!];
  if (!alias) return path; // 不认识的服务名，不纠错

  const [correctService, correctVersion] = alias;
  let correctedRest = rest;

  // 动作纠错：/docx/v1/create → /docx/v1/documents
  const actionMap = ACTION_TO_RESOURCE[correctService];
  if (actionMap) {
    const firstSegment = correctedRest.split('/')[0];
    if (actionMap[firstSegment]) {
      correctedRest = actionMap[firstSegment] + correctedRest.slice(firstSegment.length);
    }
  }

  // 特殊处理：contact/v3/users/me → authen/v1/user_info
  if (correctService === 'authen') {
    if (correctedRest.startsWith('users/me') || correctedRest === 'user_info' || correctedRest === 'info' || correctedRest === '') {
      return '/open-apis/authen/v1/user_info';
    }
  }

  // 如果 rest 为空，根据服务类型补充默认资源名
  if (!correctedRest) {
    const DEFAULT_RESOURCES: Record<string, string> = {
      docx: 'documents',
      wiki: 'spaces',
      im: 'messages',
      sheets: 'spreadsheets',
      bitable: 'apps',
      task: 'tasks',
    };
    correctedRest = DEFAULT_RESOURCES[correctService] || '';
  }

  return `/open-apis/${correctService}/${correctVersion}/${correctedRest}`;
}

// ── /actions/openapi：直接调飞书 OpenAPI，不走 tool dispatch ──
export async function handleActionsOpenApi(
  request: Request,
  env: ActionsEnv,
  origin = '*',
) {
  // 强制 OAuth：无 Bearer token 时返回 401 + WWW-Authenticate，让 ChatGPT 弹授权
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }, null, 2), {
      status: 401,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'WWW-Authenticate': 'Bearer',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': origin,
      },
    });
  }

  // 解析请求体：支持 {method,path,...} 和 {args:{method,path,...}} 两种格式
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return json({ ok: false, error: 'Body must be JSON' }, 400, origin);
  }

  let args: Record<string, unknown>;
  if (body.args && typeof body.args === 'object' && !Array.isArray(body.args)) {
    args = body.args as Record<string, unknown>;
  } else {
    args = body;
  }

  // path / method 规范化
  const method = ((args.method as string) ?? 'GET').toString().toUpperCase();
  const rawPath = ((args.path as string) ?? '').toString();

  if (!rawPath) {
    return json({ ok: false, error: '缺少 path 参数（如 /im/v1/messages）' }, 400, origin);
  }

  let normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  if (!normalizedPath.startsWith('/open-apis/') && normalizedPath !== '/open-apis') {
    normalizedPath = `/open-apis${normalizedPath}`;
  }

  // ── 路径纠错系统（版本无关） ──
  // GPT 经常猜错飞书的服务名和路径结构，这里做自动纠正。
  // 使用正则匹配 /open-apis/{service}/v{N}/... 提取服务名，按映射表替换。
  normalizedPath = correctFeishuPath(normalizedPath);

  // 获取 token（失败时返回 401 + WWW-Authenticate 触发 ChatGPT 重新授权）
  const tokenResult = await resolveAccessToken(request, env);
  if (tokenResult.error) {
    return new Response(JSON.stringify({ ok: false, error: tokenResult.error }, null, 2), {
      status: 401,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'WWW-Authenticate': 'Bearer',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': origin,
      },
    });
  }

  // 构建请求
  const url = new URL(normalizedPath, 'https://open.feishu.cn');
  if (args.query && typeof args.query === 'object') {
    for (const [k, v] of Object.entries(args.query as Record<string, unknown>)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokenResult.token}`,
  };
  if (args.headers && typeof args.headers === 'object') {
    for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
      if (k && k.toLowerCase() !== 'authorization') {
        headers[k] = String(v);
      }
    }
  }

  let fetchBody: string | undefined;
  if (method !== 'GET' && method !== 'HEAD' && args.body !== undefined) {
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }
    fetchBody = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
  }

  try {
    const resp = await fetch(url.toString(), { method, headers, body: fetchBody });
    const respText = await resp.text();
    let parsed: unknown = respText;
    try { parsed = JSON.parse(respText); } catch { /* 非 JSON 保留原文 */ }

    const parsedObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;

    // 检测飞书 token 失效（code=20005），返回 401 + WWW-Authenticate 触发 ChatGPT 重新授权
    const feishuCode = parsedObj ? Number(parsedObj.code) : NaN;
    if (feishuCode === 20005) {
      return new Response(JSON.stringify({ ok: false, status: 401, error: 'feishu_token_expired', feishu: parsed }, null, 2), {
        status: 401,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'WWW-Authenticate': 'Bearer',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': origin,
        },
      });
    }

    if (resp.ok) {
      const result = parsedObj && 'data' in parsedObj ? parsedObj.data : parsed;
      return json({ ok: true, status: resp.status, result, feishu: parsed }, 200, origin);
    }
    return json({ ok: false, status: resp.status, error: parsed || respText, feishu: parsed }, resp.status, origin);
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) }, 500, origin);
  }
}

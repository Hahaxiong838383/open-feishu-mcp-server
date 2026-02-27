import assert from 'node:assert/strict';
import { feishuOpenApiCall } from '../src/tools/openapi/call.ts';

const captured: Array<{ url: string; init: RequestInit }> = [];

globalThis.fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
  captured.push({ url: String(url), init });
  return new Response(JSON.stringify({ code: 0, msg: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-mock': '1' },
  });
};

const context = {
  getUserAccessToken: () => 'user_token_mock',
};

const cases = [
  { method: 'GET', path: '/wiki/v2/spaces', query: { page_size: 20 } },
  { method: 'POST', path: '/wiki/v2/spaces', body: { name: 'MCP Test Space' } },
  { method: 'PATCH', path: '/wiki/v2/spaces/space_token_mock', body: { name: 'MCP Updated Space' } },
  { method: 'DELETE', path: '/wiki/v2/spaces/space_token_mock' },
  { method: 'GET', path: '/sheets/v2/spreadsheets/sht_mock/metainfo' },
  { method: 'PUT', path: '/sheets/v2/spreadsheets/sht_mock/values', body: { valueRange: { range: 'A1', values: [['ok']] } } },
  { method: 'POST', path: '/bitable/v1/apps/app_mock/tables/tbl_mock/records', body: { fields: { Name: 'A' } } },
  { method: 'GET', path: '/bitable/v1/apps/app_mock/tables/tbl_mock/records/rec_mock' },
  { method: 'PUT', path: '/bitable/v1/apps/app_mock/tables/tbl_mock/records/rec_mock', body: { fields: { Name: 'B' } } },
  { method: 'DELETE', path: '/bitable/v1/apps/app_mock/tables/tbl_mock/records/rec_mock' },
  { method: 'GET', path: '/board/v1/whiteboards/wb_mock' },
  { method: 'POST', path: '/board/v1/whiteboards', body: { title: 'MCP Whiteboard' } },
  { method: 'PATCH', path: '/board/v1/whiteboards/wb_mock', body: { title: 'MCP Whiteboard Updated' } },
  { method: 'DELETE', path: '/board/v1/whiteboards/wb_mock' },
] as const;

for (const args of cases) {
  const result = await feishuOpenApiCall.callback(context, args, {} as any);
  assert.equal(result.isError, false);
}

assert.equal(captured.length, cases.length);
for (const req of captured) {
  assert.ok(req.url.startsWith('https://open.feishu.cn/open-apis/'));
  const headers = req.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer user_token_mock');
}

console.log(`Validated ${cases.length} API operations with user access token injection.`);

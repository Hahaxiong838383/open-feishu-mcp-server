import { feishuOpenApiCall } from '../src/tools/openapi/call.ts';

const context = {
  getUserAccessToken: async () => 'mock-token',
} as any;

const originalFetch = global.fetch;

global.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();

  if (url.includes('/binary')) {
    return new Response(Uint8Array.from([104, 105]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    method: init?.method,
    url,
    hasBody: Boolean(init?.body),
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

async function run() {
  const jsonResult = await feishuOpenApiCall.callback(context, {
    method: 'POST',
    path: '/im/v1/messages',
    bodyType: 'json',
    body: { msg_type: 'text', content: { text: 'hello' } },
  });

  const formResult = await feishuOpenApiCall.callback(context, {
    method: 'POST',
    path: '/bitable/v1/apps/search',
    bodyType: 'form',
    form: { page_size: 20, archived: false },
  });

  const multipartResult = await feishuOpenApiCall.callback(context, {
    method: 'POST',
    path: '/drive/v1/files/upload_all',
    bodyType: 'multipart',
    form: { parent_type: 'explorer' },
    files: [{
      fieldName: 'file',
      filename: 'hello.txt',
      dataBase64: Buffer.from('hello').toString('base64'),
    }],
  });

  const binaryResult = await feishuOpenApiCall.callback(context, {
    method: 'GET',
    path: '/binary',
    responseMode: 'binaryBase64',
  });

  console.log('json=', (jsonResult.content[0] as any).text);
  console.log('form=', (formResult.content[0] as any).text);
  console.log('multipart=', (multipartResult.content[0] as any).text);
  console.log('binary=', (binaryResult.content[0] as any).text);
}

run()
  .finally(() => {
    global.fetch = originalFetch;
  });

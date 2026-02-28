import { feishuOpenApiCall } from './call';

describe('feishu_openapi_call', () => {
  const context = {
    getUserAccessToken: async () => 'token-123',
  } as any;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('json: object body should be stringified and apply default content-type', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await feishuOpenApiCall.callback(context, {
      method: 'POST',
      path: '/im/v1/messages',
      body: { a: 1 },
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(requestInit.body).toBe(JSON.stringify({ a: 1 }));
    expect((requestInit.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('form: form fields should be encoded to URLSearchParams with form content-type', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    await feishuOpenApiCall.callback(context, {
      method: 'POST',
      path: '/sheets/v2/form',
      bodyType: 'form',
      form: { foo: 'bar', count: 2 },
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect((requestInit.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect((requestInit.body as URLSearchParams).toString()).toContain('foo=bar');
    expect((requestInit.body as URLSearchParams).toString()).toContain('count=2');
  });

  it('multipart: base64 file should append Blob into FormData', async () => {
    const append = jest.fn();
    class MockFormData {
      append = append;
    }

    const originalFormData = global.FormData;
    // @ts-expect-error test mock
    global.FormData = MockFormData;

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    await feishuOpenApiCall.callback(context, {
      method: 'POST',
      path: '/drive/v1/files/upload_all',
      bodyType: 'multipart',
      form: { folder: 'root' },
      files: [
        {
          fieldName: 'file',
          filename: 'a.txt',
          dataBase64: Buffer.from('hello').toString('base64'),
        },
      ],
    });

    expect(append).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledWith('folder', 'root');
    const fileAppendArgs = append.mock.calls.find((call) => call[0] === 'file');
    expect(fileAppendArgs?.[1]).toBeInstanceOf(Blob);
    expect(fileAppendArgs?.[2]).toBe('a.txt');

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(requestInit.body).toBeInstanceOf(MockFormData as any);

    global.FormData = originalFormData;
  });

  it('responseMode=binaryBase64 should return base64 data', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    );

    const result = await feishuOpenApiCall.callback(context, {
      method: 'GET',
      path: '/drive/v1/download',
      responseMode: 'binaryBase64',
    });

    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.dataBase64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(payload.contentType).toBe('application/octet-stream');
  });
});

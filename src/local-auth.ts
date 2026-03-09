/**
 * 本地 OAuth 授权流程
 * 首次运行：启动临时 HTTP 服务器 → 浏览器授权 → 存储 token
 * 后续运行：读取 token → 过期自动刷新
 */
import { createServer, type Server } from 'node:http';
import { URL } from 'node:url';
import { loadToken, saveToken, isTokenValid, type StoredToken } from './local-store.js';
import { fetchUpstreamAuthToken, refreshUpstreamAuthToken } from './utils.js';
import { FEISHU_SCOPE } from './config/feishu-constants.js';

const OAUTH_PORT = 9876;
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}${CALLBACK_PATH}`;

const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';

interface AuthConfig {
  appId: string;
  appSecret: string;
}

/** 打开浏览器 */
async function openBrowser(url: string) {
  const { exec } = await import('node:child_process');
  const { platform } = await import('node:os');
  const os = platform();
  const cmd = os === 'win32' ? 'start' :
              os === 'darwin' ? 'open' : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

/** 通过临时 HTTP 服务器完成 OAuth 授权 */
function doOAuthFlow(config: AuthConfig): Promise<StoredToken> {
  return new Promise((resolve, reject) => {
    let server: Server;

    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error('OAuth 授权超时（3 分钟）'));
    }, 3 * 60 * 1000);

    server = createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${OAUTH_PORT}`);

      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('Missing authorization code');
        return;
      }

      try {
        const [accessToken, refreshToken, expiresIn, err] = await fetchUpstreamAuthToken({
          code,
          upstream_url: FEISHU_TOKEN_URL,
          client_id: config.appId,
          client_secret: config.appSecret,
          redirect_uri: REDIRECT_URI,
        });

        if (err || !accessToken) {
          res.writeHead(500);
          res.end('Token 获取失败');
          reject(new Error('Token 获取失败'));
          return;
        }

        const token: StoredToken = {
          accessToken,
          refreshToken,
          expiresAt: Date.now() + (expiresIn || 7200) * 1000,
          appId: config.appId,
        };

        saveToken(token);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html><body style="font-family:sans-serif;text-align:center;padding:60px">
            <h1>✅ 飞书授权成功</h1>
            <p>你可以关闭此页面，回到终端继续使用。</p>
          </body></html>
        `);

        clearTimeout(timeout);
        server.close();
        resolve(token);
      } catch (e) {
        res.writeHead(500);
        res.end('授权处理失败');
        clearTimeout(timeout);
        server.close();
        reject(e);
      }
    });

    server.listen(OAUTH_PORT, () => {
      const authorizeUrl = new URL(FEISHU_AUTHORIZE_URL);
      authorizeUrl.searchParams.set('client_id', config.appId);
      authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('scope', FEISHU_SCOPE);

      const url = authorizeUrl.href;
      console.error(`[feishu-mcp] 请在浏览器中完成飞书授权...`);
      console.error(`[feishu-mcp] 授权链接: ${url}`);
      openBrowser(url);
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`无法启动授权服务器 (端口 ${OAUTH_PORT}): ${err.message}`));
    });
  });
}

/** 刷新 token */
async function doRefresh(token: StoredToken, config: AuthConfig): Promise<StoredToken> {
  console.error('[feishu-mcp] Token 已过期，正在刷新...');

  const [accessToken, refreshToken, expiresIn, err] = await refreshUpstreamAuthToken({
    refreshToken: token.refreshToken,
    upstream_url: FEISHU_TOKEN_URL,
    client_id: config.appId,
    client_secret: config.appSecret,
  });

  if (err || !accessToken) {
    throw new Error('Token 刷新失败，请重新授权（删除 ~/.feishu-mcp/tokens.json 后重试）');
  }

  const newToken: StoredToken = {
    ...token,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + (expiresIn || 7200) * 1000,
  };

  saveToken(newToken);
  console.error('[feishu-mcp] Token 刷新成功');
  return newToken;
}

/**
 * 获取有效的飞书 token
 * - 有缓存且未过期 → 直接返回
 * - 有缓存但过期 → 自动刷新
 * - 无缓存 → 启动浏览器 OAuth 授权
 */
export async function ensureAuth(config: AuthConfig): Promise<StoredToken> {
  const cached = loadToken(config.appId);

  if (cached) {
    if (isTokenValid(cached)) {
      console.error('[feishu-mcp] 使用缓存 token');
      return cached;
    }
    // 尝试刷新
    try {
      return await doRefresh(cached, config);
    } catch {
      console.error('[feishu-mcp] 刷新失败，重新授权...');
    }
  }

  // 首次或刷新失败 → 浏览器授权
  return doOAuthFlow(config);
}

/**
 * 创建 token 获取函数（支持自动刷新 + 文件热加载）
 * 返回一个 () => Promise<string>，每次调用时检查是否需要刷新
 *
 * 刷新优先级：
 * 1. 内存 token 有效 → 直接返回
 * 2. 内存 token 过期 → 先检查文件（HealthMonitor 可能已刷新）
 * 3. 文件 token 也过期 → 调用 API 刷新
 */
export function createTokenGetter(config: AuthConfig, initialToken: StoredToken) {
  let current = initialToken;
  let refreshing: Promise<string> | null = null;

  return async (): Promise<string> => {
    if (isTokenValid(current)) {
      return current.accessToken;
    }

    // 内存 token 过期，先检查文件（HealthMonitor 可能已通过写文件刷新了 token）
    const fromFile = loadToken(config.appId);
    if (fromFile && isTokenValid(fromFile)) {
      current = fromFile;
      console.error('[feishu-mcp] 从文件热加载了更新的 token');
      return current.accessToken;
    }

    // 文件 token 也过期，调用 API 刷新
    // 关键：用文件中的 refreshToken（可能比内存中的更新，HealthMonitor 可能已刷新过）
    if (fromFile && fromFile.refreshToken) {
      current = { ...current, refreshToken: fromFile.refreshToken };
    }

    // 避免并发刷新
    if (refreshing) return refreshing;

    refreshing = (async () => {
      try {
        current = await doRefresh(current, config);
        return current.accessToken;
      } catch (refreshErr) {
        // 刷新失败 → 可能另一个进程（HealthMonitor / 另一个 MCP 实例）已经刷新了
        // 再读一次文件，如果有效就用它（竞态恢复）
        const retryFromFile = loadToken(config.appId);
        if (retryFromFile && isTokenValid(retryFromFile)) {
          current = retryFromFile;
          console.error('[feishu-mcp] 刷新失败但文件中有有效 token（另一进程已刷新），已恢复');
          return current.accessToken;
        }
        throw refreshErr;
      }
    })();

    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  };
}

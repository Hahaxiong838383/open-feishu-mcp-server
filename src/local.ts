#!/usr/bin/env node
/**
 * 飞书 MCP 本地 stdio 服务
 *
 * 用法：
 *   node dist/local.js
 *
 * 环境变量（.env 或 CLI 参数）：
 *   FEISHU_APP_ID      飞书应用 ID
 *   FEISHU_APP_SECRET   飞书应用密钥
 */
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@larksuiteoapi/node-sdk';
import type { FeishuContext } from 'feishu-tools';

import { ensureAuth, createTokenGetter } from './local-auth.js';
import { registerToolsLite } from './register-tools.js';
import { allTools } from './tools/tools_registry.js';
import { oapiHttpInstance } from './utils/http-instance.js';

// ── 解析参数 ──
function parseArgs() {
  const args = process.argv.slice(2);
  let appId = process.env.FEISHU_APP_ID || '';
  let appSecret = process.env.FEISHU_APP_SECRET || '';

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--app-id' || args[i] === '-a') && args[i + 1]) {
      appId = args[++i];
    } else if ((args[i] === '--app-secret' || args[i] === '-s') && args[i + 1]) {
      appSecret = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.error(`
飞书 MCP 本地服务

用法：
  node dist/local.js [选项]

选项：
  -a, --app-id <id>        飞书应用 ID（或设置 FEISHU_APP_ID 环境变量）
  -s, --app-secret <secret> 飞书应用密钥（或设置 FEISHU_APP_SECRET 环境变量）
  -h, --help               显示帮助
      `);
      process.exit(0);
    }
  }

  if (!appId || !appSecret) {
    console.error('[feishu-mcp] 错误：缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');
    console.error('[feishu-mcp] 通过 .env 文件、环境变量或 --app-id / --app-secret 参数提供');
    process.exit(1);
  }

  return { appId, appSecret };
}

async function main() {
  const config = parseArgs();

  // ★ 保护 stdout：飞书 SDK 的 logger 默认用 console.log 输出到 stdout，
  // 会污染 MCP stdio 协议流导致 codex 等客户端握手失败。
  // 将 console.log 重定向到 stderr，确保 stdout 只有 JSON-RPC 消息。
  const _origLog = console.log;
  console.log = (...args: unknown[]) => console.error('[sdk]', ...args);
  console.info = (...args: unknown[]) => console.error('[sdk]', ...args);

  // 1. OAuth 授权（首次弹浏览器，后续自动刷新）
  console.error('[feishu-mcp] 正在检查飞书授权...');
  const token = await ensureAuth(config);
  console.error(`[feishu-mcp] 授权就绪 ✓`);

  // 2. 创建飞书 SDK client
  const client = new Client({
    appId: config.appId,
    appSecret: config.appSecret,
    httpInstance: oapiHttpInstance,
  });

  // 3. 创建 token 自动刷新函数
  const getAccessToken = createTokenGetter(config, token);

  // 4. 创建 MCP Server
  const server = new McpServer({
    name: 'feishu-mcp-local',
    version: '1.0.0',
  });

  const context: FeishuContext = {
    client,
    getUserAccessToken: getAccessToken,
  };

  registerToolsLite(server, allTools, context);

  // 5. 启动 stdio 传输
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[feishu-mcp] 服务已启动 (stdio)');
}

main().catch((err) => {
  console.error('[feishu-mcp] 启动失败:', err.message || err);
  process.exit(1);
});

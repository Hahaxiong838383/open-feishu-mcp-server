/**
 * 本地 token 持久化存储
 * 存储位置：~/.feishu-mcp/tokens.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  userId?: string;
  name?: string;
  appId: string;
}

const CONFIG_DIR = join(homedir(), '.feishu-mcp');
const TOKEN_FILE = join(CONFIG_DIR, 'tokens.json');

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/** 读取所有存储的 token（按 appId 索引） */
function readAll(): Record<string, StoredToken> {
  ensureDir();
  if (!existsSync(TOKEN_FILE)) return {};
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

/** 读取指定 appId 的 token */
export function loadToken(appId: string): StoredToken | null {
  const all = readAll();
  return all[appId] ?? null;
}

/** 保存 token */
export function saveToken(token: StoredToken): void {
  const all = readAll();
  all[token.appId] = token;
  ensureDir();
  writeFileSync(TOKEN_FILE, JSON.stringify(all, null, 2), 'utf-8');
}

/** token 是否有效（提前 5 分钟判定过期） */
export function isTokenValid(token: StoredToken): boolean {
  return Date.now() < token.expiresAt - 5 * 60 * 1000;
}

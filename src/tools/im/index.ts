import { z } from 'zod';
import type { ToolDefinition } from 'feishu-tools';
import { feishuFetch } from '../helpers';

// ── 列出群列表 ──

export const listChats: ToolDefinition = {
  name: 'list_chats',
  description: '列出当前用户加入的飞书群列表，返回 chat_id 和群名称。发消息前先用此工具获取目标群的 chat_id。',
  inputSchema: {
    page_size: z.number().optional().describe('每页数量，默认 20，最大 100'),
    page_token: z.string().optional().describe('分页游标'),
  },
  callback: async (context, args) => {
    return feishuFetch({
      context,
      method: 'GET',
      path: '/im/v1/chats',
      query: {
        page_size: args.page_size,
        page_token: args.page_token,
      },
    });
  },
};

// ── 获取消息列表 ──

export const listMessages: ToolDefinition = {
  name: 'list_messages',
  description: '获取指定群聊的消息历史记录。需要提供 chat_id（可通过 list_chats 获取）。',
  inputSchema: {
    container_id: z.string().describe('容器 ID，通常是 chat_id'),
    container_id_type: z.enum(['chat']).optional().describe('容器类型，默认 chat'),
    page_size: z.number().optional().describe('每页数量，默认 20，最大 50'),
    page_token: z.string().optional().describe('分页游标'),
    sort_type: z.enum(['ByCreateTimeAsc', 'ByCreateTimeDesc']).optional().describe('排序方式'),
  },
  callback: async (context, args) => {
    return feishuFetch({
      context,
      method: 'GET',
      path: '/im/v1/messages',
      query: {
        container_id_type: args.container_id_type || 'chat',
        container_id: args.container_id,
        page_size: args.page_size,
        page_token: args.page_token,
        sort_type: args.sort_type,
      },
    });
  },
};

// ── 发送消息 ──

export const sendMessage: ToolDefinition = {
  name: 'send_message',
  description: '向飞书群或用户发送消息。支持文本、富文本、卡片等消息类型。文本消息的 content 格式为 JSON 字符串，如 {"text":"你好"}。',
  inputSchema: {
    receive_id: z.string().describe('接收方 ID（chat_id、open_id、user_id 等）'),
    receive_id_type: z.enum(['chat_id', 'open_id', 'user_id', 'union_id', 'email'])
      .optional()
      .describe('接收方 ID 类型，默认 chat_id'),
    msg_type: z.enum(['text', 'post', 'image', 'interactive', 'share_chat', 'share_user', 'file', 'audio', 'media', 'sticker'])
      .optional()
      .describe('消息类型，默认 text'),
    content: z.string().describe('消息内容，JSON 字符串。文本消息示例：{"text":"Hello"}'),
  },
  callback: async (context, args) => {
    const receiveIdType = args.receive_id_type || 'chat_id';

    return feishuFetch({
      context,
      method: 'POST',
      path: `/im/v1/messages`,
      query: { receive_id_type: receiveIdType },
      body: {
        receive_id: args.receive_id,
        msg_type: args.msg_type || 'text',
        content: args.content,
      },
    });
  },
};

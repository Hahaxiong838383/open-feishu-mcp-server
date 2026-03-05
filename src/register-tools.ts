/**
 * MCP 工具注册逻辑（从 index.ts 提取，供云端和本地共用）
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDefinition, FeishuContext } from 'feishu-tools';
import { z } from 'zod';

/** 精简描述：只保留 summary 部分 */
function trimDescription(desc?: string): string {
  if (!desc) return '';
  const cut = desc.indexOf('\n\n**适用于:**');
  if (cut !== -1) return desc.substring(0, cut);
  const cut2 = desc.indexOf('\n\n**不适用于:**');
  if (cut2 !== -1) return desc.substring(0, cut2);
  const cut3 = desc.indexOf('\n\n**使用指南:**');
  if (cut3 !== -1) return desc.substring(0, cut3);
  return desc;
}

/**
 * 精简版工具注册：
 * 1. 描述只保留 summary 部分
 * 2. 去掉 outputSchema（listTools 不需要）
 * 3. 合并 heading1-9 为一个 build_heading_block 工具
 */
export function registerToolsLite(
  server: McpServer,
  tools: ToolDefinition[],
  context: FeishuContext,
) {
  const headingTools = tools.filter(t => /^build_heading\d_block$/.test(t.name));
  const otherTools = tools.filter(t => !/^build_heading\d_block$/.test(t.name));

  // 合并 heading1-9 为单个工具
  if (headingTools.length > 0) {
    const h1 = headingTools[0];
    server.registerTool(
      'build_heading_block',
      {
        description: '构建飞书文档标题块(h1-h9)。支持富文本格式（加粗、斜体、链接等）、@用户、@文档等元素。通过 level 参数指定标题级别。',
        inputSchema: {
          level: z.number().int().min(1).max(9).describe('标题级别 1-9'),
          ...(h1.inputSchema as Record<string, any>),
        },
      },
      (args: any, extra: any) => {
        const level = args.level || 1;
        const target = headingTools.find(t => t.name === `build_heading${level}_block`);
        if (!target) {
          return { content: [{ type: 'text' as const, text: `Invalid heading level: ${level}` }] };
        }
        const { level: _level, ...restArgs } = args;
        return target.callback(context, restArgs, extra);
      },
    );
  }

  // 注册其他工具（精简描述、去掉 outputSchema）
  for (const tool of otherTools) {
    server.registerTool(
      tool.name,
      {
        description: trimDescription(tool.description),
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      (args: any, extra: any) => tool.callback(context, args, extra),
    );
  }
}

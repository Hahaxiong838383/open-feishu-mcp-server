import { z } from 'zod';
import type { ToolDefinition } from 'feishu-tools';
import { feishuFetch } from '../helpers';

// ── 获取多维表格元信息 ──

export const getBitableApp: ToolDefinition = {
  name: 'get_bitable_app',
  description: '获取飞书多维表格（Bitable）的元信息，包括名称、修订版本等。',
  inputSchema: {
    app_token: z.string().describe('多维表格的 app_token（从 URL 或其他工具获取）'),
  },
  callback: async (context, args) => {
    return feishuFetch({
      context,
      method: 'GET',
      path: `/bitable/v1/apps/${args.app_token}`,
    });
  },
};

// ── 列出数据表 ──

export const listBitableTables: ToolDefinition = {
  name: 'list_bitable_tables',
  description: '列出多维表格中的所有数据表（table），返回 table_id 和名称。',
  inputSchema: {
    app_token: z.string().describe('多维表格的 app_token'),
    page_size: z.number().optional().describe('每页数量，默认 20，最大 100'),
    page_token: z.string().optional().describe('分页游标'),
  },
  callback: async (context, args) => {
    return feishuFetch({
      context,
      method: 'GET',
      path: `/bitable/v1/apps/${args.app_token}/tables`,
      query: {
        page_size: args.page_size,
        page_token: args.page_token,
      },
    });
  },
};

// ── 列出字段定义 ──

export const listBitableFields: ToolDefinition = {
  name: 'list_bitable_fields',
  description: '列出多维表格某个数据表的所有字段（列）定义，包括字段名、类型、选项等。创建/更新记录前建议先调用此工具了解表结构。',
  inputSchema: {
    app_token: z.string().describe('多维表格的 app_token'),
    table_id: z.string().describe('数据表的 table_id'),
    page_size: z.number().optional().describe('每页数量，默认 20，最大 100'),
    page_token: z.string().optional().describe('分页游标'),
  },
  callback: async (context, args) => {
    return feishuFetch({
      context,
      method: 'GET',
      path: `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/fields`,
      query: {
        page_size: args.page_size,
        page_token: args.page_token,
      },
    });
  },
};

// ── 查询记录 ──

export const listBitableRecords: ToolDefinition = {
  name: 'list_bitable_records',
  description: '查询多维表格中某个数据表的记录，支持筛选、排序和分页。',
  inputSchema: {
    app_token: z.string().describe('多维表格的 app_token'),
    table_id: z.string().describe('数据表的 table_id'),
    filter: z.string().optional().describe('筛选条件，飞书过滤语法（如 AND(CurrentValue.[字段]="值")）'),
    sort: z.string().optional().describe('排序条件 JSON 字符串（如 [{"field_name":"创建时间","desc":true}]）'),
    field_names: z.string().optional().describe('指定返回字段名，JSON 数组字符串（如 ["姓名","状态"]）'),
    page_size: z.number().optional().describe('每页数量，默认 20，最大 500'),
    page_token: z.string().optional().describe('分页游标'),
  },
  callback: async (context, args) => {
    const query: Record<string, string | number | boolean | undefined> = {
      page_size: args.page_size,
      page_token: args.page_token,
    };
    if (args.filter) query.filter = args.filter;
    if (args.sort) query.sort = args.sort;
    if (args.field_names) query.field_names = args.field_names;

    return feishuFetch({
      context,
      method: 'GET',
      path: `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records`,
      query,
    });
  },
};

// ── 新增记录 ──

export const createBitableRecord: ToolDefinition = {
  name: 'create_bitable_record',
  description: '向多维表格的数据表新增一条记录。fields 是字段名到值的映射。建议先用 list_bitable_fields 了解表结构。',
  inputSchema: {
    app_token: z.string().describe('多维表格的 app_token'),
    table_id: z.string().describe('数据表的 table_id'),
    fields: z.record(z.string(), z.any()).describe('字段值映射，key 为字段名，value 为对应值'),
  },
  callback: async (context, args) => {
    return feishuFetch({
      context,
      method: 'POST',
      path: `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records`,
      body: { fields: args.fields },
    });
  },
};

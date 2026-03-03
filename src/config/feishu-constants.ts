/**
 * 飞书文档相关常量配置
 */
export const FEISHU_CONSTANTS = {
  // 文档块类型
  BLOCK_TYPES: {
    TEXT: 1,
    HEADING: 2,
    ADDONS: 40, // 文档小组件类型
  },
  
  // 文档小组件类型ID
  COMPONENT_TYPE_IDS: {
    MERMAID_DRAWING: 'blk_631fefbbae02400430b8f9f4', // 文本绘图组件
    GLOSSARY: 'blk_604dc919d3c0800173e7963c', // 名词解释组件
    TIMELINE: 'blk_6358a421bca0001c22536e4c', // 时间轴组件
    CATALOG_NAVIGATION: 'blk_637dcc698597401c1a8fd711', // 目录导航组件
    INFORMATION_COLLECTION: 'blk_6358a421bca0001c1ce11f5f', // 信息收集组件
    COUNTDOWN: 'blk_6358a421bca0001c1ce10709', // 倒计时组件
  },
  
  // 默认配置
  DEFAULTS: {
    REVISION_ID: -1,
    USER_ID_TYPE: 'open_id',
  },
  
  // 主题选项
  THEMES: {
    DEFAULT: 'default',
    DARK: 'dark',
    FOREST: 'forest',
    NEUTRAL: 'neutral',
  } as const,
} as const;

export type FeishuTheme = keyof typeof FEISHU_CONSTANTS.THEMES

/**
 * 飞书 OAuth 授权 scope（空格分隔）。
 * 所有 OAuth 路径（MCP SSE / Actions Bridge）统一使用此常量，
 * 避免硬编码不一致导致功能缺失。
 */
export const FEISHU_SCOPE = [
  'offline_access',

  // Contacts / user info
  'auth:user.id:read',
  'contact:user.base:readonly',
  // 'contact:contact:readonly',  // 20027：需在应用后台单独开通

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
  'drive:file:upload',
  'docs:document:import',
  'docs:document.media:upload',
  'docx:document',
  'docx:document:readonly',
  'docx:document.block:convert',

  // Wiki
  'wiki:wiki',
  'wiki:wiki:readonly',
  'wiki:node:read',
  // wiki:space / wiki:node 等名称不存在于飞书 OAuth（20043），
  // wiki:wiki + wiki:node:read 已覆盖知识库读写权限

  // Bitable / Base (多维表格)
  // bitable:app + bitable:app:readonly 已覆盖多维表格读写
  // bitable:record:write / bitable:record:readonly / base:record:write 名称不存在（20043）
  'bitable:app',
  'bitable:app:readonly',
  'base:field:read',
  'base:record:read',

  // Tasks
  'task:task',
  'task:task:readonly',
  'task:task:read',

  // Whiteboard (画板)
  'board:whiteboard:node:read',
].join(' ');
import type { ToolDefinition } from 'feishu-tools';
import {
  // authen
  getUserInfo,
  // docx
  createDocument,
  getDocument,
  getDocumentRawContent,
  convertContentToBlocks,
  // docx blocks
  listDocumentBlocks,
  createBlocks,
  deleteBlock,
  batchDeleteBlocks,
  buildTextBlock,
  buildHeading1Block,
  buildHeading2Block,
  buildHeading3Block,
  buildHeading4Block,
  buildHeading5Block,
  buildHeading6Block,
  buildHeading7Block,
  buildHeading8Block,
  buildHeading9Block,
  buildBulletBlock,
  buildOrderedBlock,
  buildQuoteBlock,
  buildEquationBlock,
  buildTodoBlock,
  buildCodeBlock,
  buildDividerBlock,
  buildCalloutBlock,
  searchFeishuCalloutEmoji,
  createFileBlock,
  createImageBlock,
  buildIframeBlock,
  buildChatCardBlock,
  buildGridBlock,
  buildMermaidBlock,
  buildGlossaryBlock,
  buildTimelineBlock,
  buildCatalogNavigationBlock,
  buildInformationCollectionBlock,
  buildCountdownBlock,
  // drive
  listFileComments,
  // sheets
  addSheet,
  copySheet,
  createSpreadsheet,
  deleteSheet,
  getSheet,
  getSpreadsheet,
  querySheets,
  updateSheetMetadata,
  updateSheetProtection,
  updateSheetViewSettings,
  updateSpreadsheet,
} from 'feishu-tools';
import { feishuOpenApiCall } from './openapi';

/** 全量工具列表 —— 用于 Actions Bridge REST API */
export const allTools: ToolDefinition[] = [
  getUserInfo,
  createDocument,
  getDocument,
  getDocumentRawContent,
  convertContentToBlocks,
  listDocumentBlocks,
  createBlocks,
  deleteBlock,
  batchDeleteBlocks,
  buildTextBlock,
  buildHeading1Block,
  buildHeading2Block,
  buildHeading3Block,
  buildHeading4Block,
  buildHeading5Block,
  buildHeading6Block,
  buildHeading7Block,
  buildHeading8Block,
  buildHeading9Block,
  buildBulletBlock,
  buildOrderedBlock,
  buildQuoteBlock,
  buildEquationBlock,
  buildTodoBlock,
  buildCodeBlock,
  buildDividerBlock,
  buildCalloutBlock,
  searchFeishuCalloutEmoji,
  createFileBlock,
  createImageBlock,
  buildIframeBlock,
  buildChatCardBlock,
  buildGridBlock,
  buildMermaidBlock,
  buildGlossaryBlock,
  buildTimelineBlock,
  buildCatalogNavigationBlock,
  buildInformationCollectionBlock,
  buildCountdownBlock,
  listFileComments,
  addSheet,
  copySheet,
  createSpreadsheet,
  deleteSheet,
  getSheet,
  getSpreadsheet,
  querySheets,
  updateSheetMetadata,
  updateSheetProtection,
  updateSheetViewSettings,
  updateSpreadsheet,
  feishuOpenApiCall,
];

/**
 * MCP 核心工具列表 —— 超精简子集，避免 GPT listTools ResponseTooLargeError。
 *
 * 设计原则：
 * - 去掉所有独立块构建工具（inputSchema 含深层嵌套 textElementSchema，每个 3-5KB）
 * - 用 convert_content_to_blocks 替代（接收 markdown/HTML，schema 仅 3 个字段）
 * - feishu_openapi_call 万能工具覆盖所有未列出的 API
 */
export const mcpCoreTools: ToolDefinition[] = [
  // 用户
  getUserInfo,
  // 文档 CRUD
  createDocument,
  getDocument,
  getDocumentRawContent,
  convertContentToBlocks,
  listDocumentBlocks,
  createBlocks,
  deleteBlock,
  // 电子表格
  createSpreadsheet,
  getSpreadsheet,
  getSheet,
  querySheets,
  // 万能工具（覆盖所有未列出的 API）
  feishuOpenApiCall,
];

import { z } from 'zod';
import type { ToolDefinition } from 'feishu-tools';
import { feishuFetch } from '../helpers';

// ── 类型定义 ──

interface WhiteboardNode {
  id?: string;
  type?: string;
  // 格式 A（扁平）
  x?: number;
  y?: number;
  parent_id?: string;
  style?: { fill_color?: string; [k: string]: unknown };
  composite_shape?: { type?: string };
  // 格式 B（嵌套 props）
  parentId?: string;
  props?: {
    x?: number;
    y?: number;
    fill?: { color?: string };
    shapeType?: string;
    [k: string]: unknown;
  };
  // 通用
  text?: {
    text?: string;
    font_size?: number;
    font_weight?: string;
    text_color?: string;
    [k: string]: unknown;
  };
  table?: {
    cells?: TableCell[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface TableCell {
  row_index?: number;
  col_index?: number;
  text?: { text?: string; [k: string]: unknown };
  merge_info?: { col_span?: number; row_span?: number };
  style?: { fill_color?: string; [k: string]: unknown };
}

interface ShapeEntry {
  parent: string;
  y: number;
  x: number;
  text: string;
  font_size: number;
  font_weight: string;
  fill: string;
  shape: string;
}

interface CompactShapeEntry {
  p: string;
  y: number;
  x: number;
  t: string;
  fs: number;
  fw: string;
  f: string;
  s: string;
}

interface CellEntry {
  row: number;
  col: number;
  text: string;
  merge: { col_span: number; row_span: number } | null;
  fill: string;
}

interface CompactCellEntry {
  r: number;
  c: number;
  t: string;
  m?: { cs: number; rs: number };
  f?: string;
}

interface TableEntry {
  parent: string;
  rows: number;
  cols: number;
  cells: CellEntry[];
}

interface CompactTableEntry {
  p: string;
  rows: number;
  cols: number;
  cells: CompactCellEntry[];
}

// ── 脚手架文本检测 ──

const SCAFFOLD_PATTERNS = [
  /^Q[1-4]$/,                    // Q1, Q2, Q3, Q4
  /^\d{1,2}月$/,                  // 1月-12月
  /^里程碑\d+$/,                  // 里程碑1-6
  /^季度分解目标/,                // 季度分解目标：目标完成标准
  /^目标撰写模板$/,               // 星形模板标记
];

// 长模板文本（>500字符且包含特定关键词的通用模板说明）
function isTemplateText(text: string): boolean {
  return text.length > 500 && (
    text.includes('结果型目标') && text.includes('过程型目标') ||
    text.includes('填空示例') && text.includes('模板')
  );
}

function isScaffolding(text: string): boolean {
  if (isTemplateText(text)) return true;
  return SCAFFOLD_PATTERNS.some((p) => p.test(text));
}

// ── 格式探测与取值 ──

function detectFormat(sample: WhiteboardNode): 'A' | 'B' {
  return 'x' in sample ? 'A' : 'B';
}

function getXY(node: WhiteboardNode, fmt: 'A' | 'B'): [number, number] {
  if (fmt === 'A') {
    return [Math.round(node.x ?? 0), Math.round(node.y ?? 0)];
  }
  const p = node.props;
  return [Math.round(p?.x ?? 0), Math.round(p?.y ?? 0)];
}

function getParent(node: WhiteboardNode, fmt: 'A' | 'B'): string {
  if (fmt === 'A') return node.parent_id ?? '';
  return node.parentId ?? '';
}

function getFill(node: WhiteboardNode, fmt: 'A' | 'B'): string {
  if (fmt === 'A') return node.style?.fill_color ?? '';
  return node.props?.fill?.color ?? '';
}

function getShapeType(node: WhiteboardNode, fmt: 'A' | 'B'): string {
  if (fmt === 'A') {
    const cs = node.composite_shape;
    return typeof cs === 'object' && cs ? (cs.type ?? '') : '';
  }
  return (node.props?.shapeType as string) ?? '';
}

function getText(node: WhiteboardNode): string {
  const t = node.text;
  if (!t || typeof t !== 'object') return '';
  return (t.text ?? '').trim();
}

// ── 解析主函数 ──

function parseWhiteboardNodes(
  rawNodes: unknown,
  compact: boolean,
): {
  summary: {
    total_nodes: number;
    shapes_with_text: number;
    tables: number;
    format: string;
    filtered_scaffolding?: number;
  };
  shapes: (ShapeEntry | CompactShapeEntry)[];
  tables: (TableEntry | CompactTableEntry)[];
} {
  // 统一转为数组
  let nodes: WhiteboardNode[];
  if (Array.isArray(rawNodes)) {
    nodes = rawNodes;
  } else if (rawNodes && typeof rawNodes === 'object') {
    nodes = Object.values(rawNodes);
  } else {
    return {
      summary: { total_nodes: 0, shapes_with_text: 0, tables: 0, format: 'unknown' },
      shapes: [],
      tables: [],
    };
  }

  if (nodes.length === 0) {
    return {
      summary: { total_nodes: 0, shapes_with_text: 0, tables: 0, format: 'unknown' },
      shapes: [],
      tables: [],
    };
  }

  const fmt = detectFormat(nodes[0]);
  let filteredCount = 0;

  // 提取 shapes（composite_shape + text_shape）
  const shapes: (ShapeEntry | CompactShapeEntry)[] = [];
  for (const node of nodes) {
    const ntype = node.type ?? '';
    if (ntype !== 'composite_shape' && ntype !== 'text_shape') continue;
    const text = getText(node);
    if (!text) continue;

    // compact 模式下过滤脚手架文本
    if (compact && isScaffolding(text)) {
      filteredCount++;
      continue;
    }

    const [x, y] = getXY(node, fmt);
    const parent = getParent(node, fmt);
    const fill = getFill(node, fmt);
    const shape = getShapeType(node, fmt);
    const fontSize = node.text?.font_size ?? 0;
    const fontWeight = node.text?.font_weight ?? '';

    if (compact) {
      const entry: CompactShapeEntry = { p: parent, y, x, t: text, fs: fontSize, fw: fontWeight, f: fill, s: shape };
      // 省略空字段
      if (!entry.p) delete (entry as Record<string, unknown>).p;
      if (!entry.f) delete (entry as Record<string, unknown>).f;
      if (!entry.s) delete (entry as Record<string, unknown>).s;
      if (!entry.fw) delete (entry as Record<string, unknown>).fw;
      if (!entry.fs) delete (entry as Record<string, unknown>).fs;
      shapes.push(entry);
    } else {
      shapes.push({ parent, y, x, text, font_size: fontSize, font_weight: fontWeight, fill, shape });
    }
  }

  // 按 (parent, y, x) 排序还原阅读顺序
  shapes.sort((a, b) => {
    const ap = 'parent' in a ? a.parent : (a as CompactShapeEntry).p ?? '';
    const bp = 'parent' in b ? b.parent : (b as CompactShapeEntry).p ?? '';
    if (ap !== bp) return ap < bp ? -1 : 1;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });

  // 提取 tables
  const tables: (TableEntry | CompactTableEntry)[] = [];
  for (const node of nodes) {
    if (node.type !== 'table') continue;
    const rawCells = node.table?.cells;
    if (!rawCells || !Array.isArray(rawCells) || rawCells.length === 0) continue;

    const maxRow = Math.max(...rawCells.map((c) => (c.row_index ?? 0))) + 1;
    const maxCol = Math.max(...rawCells.map((c) => (c.col_index ?? 0))) + 1;

    const sorted = [...rawCells].sort(
      (a, b) => (a.row_index ?? 0) - (b.row_index ?? 0) || (a.col_index ?? 0) - (b.col_index ?? 0),
    );

    const parent = getParent(node, fmt);

    if (compact) {
      const cells: CompactCellEntry[] = [];
      for (const cell of sorted) {
        const t = cell.text;
        const text = t && typeof t === 'object' ? (t.text ?? '').trim() : '';
        if (!text) continue;

        const merge = cell.merge_info;
        const hasMerge = merge && ((merge.col_span ?? 1) > 1 || (merge.row_span ?? 1) > 1);
        const fill = cell.style?.fill_color ?? '';

        const entry: CompactCellEntry = { r: cell.row_index ?? 0, c: cell.col_index ?? 0, t: text };
        if (hasMerge) entry.m = { cs: merge!.col_span ?? 1, rs: merge!.row_span ?? 1 };
        if (fill) entry.f = fill;
        cells.push(entry);
      }

      const tEntry: CompactTableEntry = { p: parent, rows: maxRow, cols: maxCol, cells };
      if (!tEntry.p) delete (tEntry as Record<string, unknown>).p;
      tables.push(tEntry);
    } else {
      const cells: CellEntry[] = [];
      for (const cell of sorted) {
        const t = cell.text;
        const text = t && typeof t === 'object' ? (t.text ?? '').trim() : '';
        if (!text) continue;

        const merge = cell.merge_info;
        const hasMerge = merge && ((merge.col_span ?? 1) > 1 || (merge.row_span ?? 1) > 1);

        cells.push({
          row: cell.row_index ?? 0,
          col: cell.col_index ?? 0,
          text,
          merge: hasMerge ? { col_span: merge!.col_span ?? 1, row_span: merge!.row_span ?? 1 } : null,
          fill: cell.style?.fill_color ?? '',
        });
      }

      tables.push({ parent, rows: maxRow, cols: maxCol, cells });
    }
  }

  const summary: {
    total_nodes: number;
    shapes_with_text: number;
    tables: number;
    format: string;
    filtered_scaffolding?: number;
  } = {
    total_nodes: nodes.length,
    shapes_with_text: shapes.length,
    tables: tables.length,
    format: fmt === 'A' ? 'A (flat)' : 'B (props)',
  };

  if (compact && filteredCount > 0) {
    summary.filtered_scaffolding = filteredCount;
  }

  return { summary, shapes, tables };
}

// ── MCP 工具定义 ──

export const readWhiteboardText: ToolDefinition = {
  name: 'read_whiteboard_text',
  description:
    '读取飞书画板/白板中的所有文字内容。自动识别两种数据格式(A扁平/B嵌套props)，提取 shapes（图形文字）和 tables（表格），按空间位置排序返回结构化 JSON。默认 compact 模式过滤时间轴标签等脚手架文本、压缩字段名、节省输出空间。需要 board:whiteboard:node:read 权限。',
  inputSchema: {
    board_token: z
      .string()
      .describe(
        '画板 token。从飞书文档链接的 blockToken 参数获取，或通过 list_document_blocks 找到 block_type=43 的块提取。',
      ),
    compact: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        '紧凑模式(默认true)：过滤Q1-Q4/月份/里程碑等脚手架文本，使用短字段名(p=parent,t=text,y,x,fs=font_size,fw=font_weight,f=fill,s=shape；表格:r=row,c=col,m=merge,cs/rs=col_span/row_span)，省略空字段，压缩JSON。设为false返回完整详细格式。',
      ),
  },
  callback: async (context, args) => {
    const { board_token, compact = true } = args;

    // 1. 调用飞书画板 API
    const result = await feishuFetch({
      context,
      method: 'GET',
      path: `/board/v1/whiteboards/${board_token}/nodes`,
    });

    if (result.isError) return result;

    // 2. 解析 API 返回
    let apiData: unknown;
    try {
      apiData = JSON.parse(result.content[0].text);
    } catch {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: '无法解析画板 API 返回数据' }],
      };
    }

    // feishuFetch 已展开 data，result 里就是 { ok, status, result: { nodes: [...] } }
    const wrapper = apiData as Record<string, unknown>;
    const inner = wrapper.result as Record<string, unknown> | undefined;
    const rawNodes = inner?.nodes;

    if (!rawNodes) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `画板节点为空。API 返回结构: ${JSON.stringify(Object.keys(wrapper))}`,
          },
        ],
      };
    }

    // 3. 解析节点
    const parsed = parseWhiteboardNodes(rawNodes, compact);

    // compact 模式用无缩进 JSON 进一步压缩
    const jsonStr = compact ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2);

    return {
      content: [{ type: 'text' as const, text: jsonStr }],
    };
  },
};

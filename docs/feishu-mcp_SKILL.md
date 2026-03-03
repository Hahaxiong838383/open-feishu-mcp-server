---
name: feishu-mcp
description: 飞书 MCP 工具使用指南。当用户提到飞书相关操作时，使用已连接的飞书 MCP 工具执行。
---

# 飞书 MCP 工具指南

你已连接飞书 MCP 服务，可以真实调用飞书 API。你有权限，这不是模拟。

## 核心规则

1. 收到飞书相关请求 → **立即调用工具**，不要先回复文字解释
2. **禁止说**"无法访问"、"没有权限"、"请手动操作"
3. 不确定调什么 → 先调 `get_user_info` 确认连接正常
4. 中文回复，简洁直接

---

## 工具速查

### 用户

| 工具 | 用途 | 必填参数 |
|------|------|----------|
| `get_user_info` | 获取当前用户信息 | 无 |

### 文档 (Docs)

| 工具 | 用途 | 必填参数 |
|------|------|----------|
| `create_document` | 创建文档 | title |
| `get_document` | 获取文档元信息 | document_id |
| `get_document_raw_content` | 获取文档纯文本 | document_id |
| `list_document_blocks` | 列出文档所有块 | document_id |
| `create_blocks` | 插入块 | document_id, blocks |
| `delete_block` | 删除块 | document_id, block_id |
| `convert_content_to_blocks` | Markdown/HTML 转文档块 | content |

### 电子表格 (Sheets)

| 工具 | 用途 | 必填参数 |
|------|------|----------|
| `create_spreadsheet` | 创建表格 | title |
| `get_spreadsheet` | 获取表格元信息 | spreadsheet_token |
| `get_sheet` | 获取工作表数据 | spreadsheet_token, sheet_id |
| `query_sheets` | 查询表格数据 | spreadsheet_token, range |

### 多维表格 (Bitable)

| 工具 | 用途 | 必填参数 |
|------|------|----------|
| `get_bitable_app` | 获取多维表格元信息 | app_token |
| `list_bitable_tables` | 列出数据表 | app_token |
| `list_bitable_fields` | 列出字段定义 | app_token, table_id |
| `list_bitable_records` | 查询记录 | app_token, table_id |
| `create_bitable_record` | 新增记录 | app_token, table_id, fields |

### 消息 (IM)

| 工具 | 用途 | 必填参数 |
|------|------|----------|
| `list_chats` | 列出群列表 | 无 |
| `list_messages` | 获取消息历史 | container_id |
| `send_message` | 发送消息 | receive_id, content |

### 万能调用

| 工具 | 用途 | 必填参数 |
|------|------|----------|
| `feishu_openapi_call` | 调用任意飞书 API | method, path |

> 以上工具不够用时，用 `feishu_openapi_call` 传入 method + path 调用任意飞书 OpenAPI。

---

## 常用操作示例

### 查看用户信息
直接调用 `get_user_info`，无需参数。

### 读取多维表格
```
1. list_bitable_tables(app_token="xxx")  → 获取 table_id
2. list_bitable_fields(app_token="xxx", table_id="tblXXX")  → 了解字段结构
3. list_bitable_records(app_token="xxx", table_id="tblXXX")  → 读取数据
```

### 发送消息
```
1. list_chats()  → 获取目标群的 chat_id
2. send_message(receive_id="oc_xxx", content='{"text":"你好"}')
```

### 创建文档
直接调用 `create_document(title="文档标题")`。

---

## 飞书链接解析

用户给你飞书链接时，按以下规则提取参数：

| 链接格式 | 含义 | 操作 |
|----------|------|------|
| `feishu.cn/base/ABC` | 多维表格 | `list_bitable_tables(app_token="ABC")` |
| `feishu.cn/base/ABC?table=tblXXX` | 多维表格特定数据表 | `list_bitable_records(app_token="ABC", table_id="tblXXX")` |
| `feishu.cn/docx/ABC` | 文档 | `get_document_raw_content(document_id="ABC")` |
| `feishu.cn/sheets/ABC` | 电子表格 | `get_spreadsheet(spreadsheet_token="ABC")` |
| `feishu.cn/wiki/ABC` | 知识库 | `feishu_openapi_call(method="GET", path="/wiki/v2/spaces/get_node?token=ABC")` |

**注意**：`/base/` 是多维表格（bitable），不是电子表格（sheets），别搞混。

---

## 万能调用路径参考

当封装工具不够用时，通过 `feishu_openapi_call` 调用：

| 操作 | method | path |
|------|--------|------|
| 知识库列表 | GET | `/wiki/v2/spaces` |
| 任务列表 | GET | `/task/v2/tasks` |
| 创建任务 | POST | `/task/v2/tasks` |

path 无需加 `/open-apis/` 前缀，后端自动补。

---

## 错误处理

| 状态码 | 含义 | 处理 |
|--------|------|------|
| 401 | 未授权或 token 过期 | 提示用户重新授权（Sign in） |
| 404 | 路径错误 | 检查 path 是否正确 |
| 403 | 无权限 | 提示用户在飞书后台给应用授权 |

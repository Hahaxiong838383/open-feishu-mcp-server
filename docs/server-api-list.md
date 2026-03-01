# 飞书服务端 API 能力清单

> 记录当前项目已集成和可扩展的飞书 API 能力。

---

## 能力总览

| 服务 | 已封装工具 | MCP 核心 | OpenAPI 路径 | 路径纠错 |
|------|----------|---------|-------------|---------|
| 用户/认证 (authen) | 1 | 1 | 1 | ✅ |
| 文档 (docx) | 30+ | 7 | 4 | ✅ |
| 电子表格 (sheets) | 11 | 4 | 3 | ✅ |
| 云空间 (drive) | 1 | 0 | - | - |
| 知识库 (wiki) | 0 | 0 | 1 | ✅ |
| 消息 (im) | 3 | 3 | 2 | ✅ |
| 多维表格 (bitable) | 5 | 4 | 3 | ✅ |
| 任务 (task) | 0 | 0 | 1 | ✅ |
| 万能调用 (openapi) | 1 | 1 | - | ✅ |

**说明**：
- **已封装工具**：在 `allTools` (Actions Bridge) 中注册的工具数
- **MCP 核心**：在 `mcpCoreTools` (MCP 协议) 中的工具数
- **OpenAPI 路径**：GPT 系统指令中定义的可调用路径数
- **路径纠错**：`correctFeishuPath` 引擎覆盖

---

## 1. 用户/认证 (authen)

### 已集成

| 工具名 | 用途 | allTools | mcpCore |
|--------|------|----------|---------|
| `getUserInfo` | 获取当前用户信息 | ✅ | ✅ |

### OpenAPI 路径

| method | path | 用途 |
|--------|------|------|
| GET | `/authen/v1/user_info` | 获取当前用户信息 |

### 路径纠错覆盖

`contact` / `user` / `users` / `account` / `auth` → `authen/v1`

---

## 2. 文档 (docx)

### 已集成 — 核心工具

| 工具名 | 用途 | allTools | mcpCore |
|--------|------|----------|---------|
| `createDocument` | 创建文档 | ✅ | ✅ |
| `getDocument` | 获取文档元信息 | ✅ | ✅ |
| `getDocumentRawContent` | 获取文档纯文本 | ✅ | ✅ |
| `convertContentToBlocks` | Markdown/HTML 转文档块 | ✅ | ✅ |
| `listDocumentBlocks` | 列出文档所有块 | ✅ | ✅ |
| `createBlocks` | 插入块 | ✅ | ✅ |
| `deleteBlock` | 删除块 | ✅ | ✅ |

### 已集成 — 块构建工具（仅 allTools，不在 mcpCore）

> schema 过大（每个 3-5KB），MCP 用 `convertContentToBlocks` 替代。

`buildTextBlock` / `buildHeading[1-9]Block` / `buildBulletBlock` / `buildOrderedBlock` / `buildQuoteBlock` / `buildEquationBlock` / `buildTodoBlock` / `buildCodeBlock` / `buildDividerBlock` / `buildCalloutBlock` / `createFileBlock` / `createImageBlock` / `buildIframeBlock` / `buildChatCardBlock` / `buildGridBlock` / `buildMermaidBlock` / `buildGlossaryBlock` / `buildTimelineBlock` / `buildCatalogNavigationBlock` / `buildInformationCollectionBlock` / `buildCountdownBlock` / `batchDeleteBlocks` / `searchFeishuCalloutEmoji`

### OpenAPI 路径

| method | path | 用途 |
|--------|------|------|
| POST | `/docx/v1/documents` | 创建文档 |
| GET | `/docx/v1/documents/{document_id}/raw_content` | 读文档 |
| GET | `/docx/v1/documents/{document_id}/blocks` | 列出块 |

### 路径纠错覆盖

`doc` / `docs` / `document` / `documents` → `docx/v1`；动作 `create` → `documents`

---

## 3. 电子表格 (sheets)

### 已集成

| 工具名 | 用途 | allTools | mcpCore |
|--------|------|----------|---------|
| `createSpreadsheet` | 创建表格 | ✅ | ✅ |
| `getSpreadsheet` | 获取表格元信息 | ✅ | ✅ |
| `getSheet` | 获取工作表数据 | ✅ | ✅ |
| `querySheets` | 查询表格数据 | ✅ | ✅ |
| `addSheet` | 新增工作表 | ✅ | ❌ |
| `copySheet` | 复制工作表 | ✅ | ❌ |
| `deleteSheet` | 删除工作表 | ✅ | ❌ |
| `updateSheetMetadata` | 更新工作表元数据 | ✅ | ❌ |
| `updateSheetProtection` | 更新保护设置 | ✅ | ❌ |
| `updateSheetViewSettings` | 更新视图设置 | ✅ | ❌ |
| `updateSpreadsheet` | 更新表格 | ✅ | ❌ |

### OpenAPI 路径

| method | path | 用途 |
|--------|------|------|
| POST | `/sheets/v3/spreadsheets` | 创建表格 |
| GET | `/sheets/v2/spreadsheets/{token}/values/{range}` | 读数据 |
| PUT | `/sheets/v2/spreadsheets/{token}/values` | 写数据 |

### 路径纠错覆盖

`spreadsheet` / `spreadsheets` / `sheet` → `sheets/v3`

---

## 4. 云空间 (drive)

### 已集成

| 工具名 | 用途 | allTools | mcpCore |
|--------|------|----------|---------|
| `listFileComments` | 列出文件评论 | ✅ | ❌ |

### 可扩展的飞书 API

| method | path | 用途 |
|--------|------|------|
| GET | `/drive/v1/files/{file_token}` | 获取文件元信息 |
| GET | `/drive/v1/files?folder_token={token}` | 列出文件夹内容 |
| POST | `/drive/v1/files/upload_all` | 上传文件 |

---

## 5. 知识库 (wiki) ⚠️ 无封装工具

### 通过 OpenAPI 万能调用支持

| method | path | 用途 |
|--------|------|------|
| GET | `/wiki/v2/spaces` | 空间列表 |
| GET | `/wiki/v2/spaces/{space_id}` | 空间详情 |
| GET | `/wiki/v2/spaces/{space_id}/nodes` | 节点列表 |
| GET | `/wiki/v2/spaces/get_node?token={token}` | 节点详情 |

### 路径纠错覆盖

`knowledge` → `wiki/v2`

---

## 6. 消息 (im)

### 已集成

| 工具名 | 用途 | allTools | mcpCore |
|--------|------|----------|---------|
| `listChats` | 列出群列表 | ✅ | ✅ |
| `listMessages` | 获取消息历史 | ✅ | ✅ |
| `sendMessage` | 发送消息 | ✅ | ✅ |

### OpenAPI 路径

| method | path | 用途 |
|--------|------|------|
| GET | `/im/v1/chats` | 群列表 |
| POST | `/im/v1/messages?receive_id_type=chat_id` | 发消息 |
| GET | `/im/v1/messages?container_id_type=chat&container_id={chat_id}` | 消息列表 |

### 路径纠错覆盖

`messages` / `message` / `chat` → `im/v1`

---

## 7. 多维表格 (bitable)

### 已集成

| 工具名 | 用途 | allTools | mcpCore |
|--------|------|----------|---------|
| `getBitableApp` | 获取多维表格元信息 | ✅ | ❌ |
| `listBitableTables` | 列出数据表 | ✅ | ✅ |
| `listBitableFields` | 列出字段定义 | ✅ | ✅ |
| `listBitableRecords` | 查询记录 | ✅ | ✅ |
| `createBitableRecord` | 新增记录 | ✅ | ✅ |

### OpenAPI 路径

| method | path | 用途 |
|--------|------|------|
| GET | `/bitable/v1/apps/{app_token}` | 元信息 |
| GET | `/bitable/v1/apps/{app_token}/tables` | 数据表列表 |
| GET | `/bitable/v1/apps/{app_token}/tables/{table_id}/fields` | 字段列表 |
| GET | `/bitable/v1/apps/{app_token}/tables/{table_id}/records` | 查记录 |
| POST | `/bitable/v1/apps/{app_token}/tables/{table_id}/records` | 新增记录 |

### 路径纠错覆盖

`base` / `table` / `tables` → `bitable/v1`；sheets 路径含 `tbl` 前缀自动切换

---

## 8. 任务 (task) ⚠️ 无封装工具

### 通过 OpenAPI 万能调用支持

| method | path | 用途 |
|--------|------|------|
| GET | `/task/v2/tasks` | 任务列表 |
| POST | `/task/v2/tasks` | 创建任务 |

### 路径纠错覆盖

`tasks` / `todo` / `todos` → `task/v2`

---

## 9. 万能调用 (feishu_openapi_call)

| 工具名 | 用途 | allTools | mcpCore |
|--------|------|----------|---------|
| `feishuOpenApiCall` | 调用任意飞书 OpenAPI | ✅ | ✅ |

**能力**：覆盖所有未单独封装的飞书 API。内置路径纠错引擎 `correctFeishuPath`，支持三种路径格式、服务名别名、版本号无关纠错。

---

## 架构说明

```
用户请求
  │
  ├─ MCP 协议 → mcpCoreTools (20 个精简工具)
  │
  └─ GPT Actions → allTools (60 个完整工具)
       │
       ├─ 已封装工具 → 直接调用
       │
       └─ feishu_openapi_call → correctFeishuPath 路径纠错 → 飞书 OpenAPI
            │
            └─ /actions/openapi 端点 → correctFeishuPath → 飞书 OpenAPI
```

---

## 扩展建议

以下服务尚无封装工具，可按需扩展：

| 服务 | 优先级 | 原因 |
|------|--------|------|
| 知识库 (wiki) | 中 | 有路径但无封装 |
| 任务 (task) | 中 | 结构简单，封装价值有限 |
| 审批 (approval) | 低 | 当前无任何支持 |
| 日历 (calendar) | 低 | 当前无任何支持 |
| 考勤 (attendance) | 低 | 当前无任何支持 |

**已完成**：多维表格 (bitable) 和消息 (im) 已封装为专用工具。

**当前策略**：缺失封装的服务均可通过 `feishu_openapi_call` 万能工具 + 路径纠错引擎覆盖，功能上不受阻。封装工具的价值在于提供参数校验和更好的调用体验。

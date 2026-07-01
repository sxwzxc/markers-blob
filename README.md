# EdgeOne Blob 云盘

基于 [EdgeOne Pages](https://edgeone.ai/pages) + [`@edgeone/pages-blob`](https://www.npmjs.com/package/@edgeone/pages-blob) 的简易云盘应用。全部存储由 Pages Blob 承载，边缘函数提供 API，单页 HTML 提供界面。

## 功能

- **用户系统**：注册 / 登录 / 登出，HMAC 签名 Token 鉴权，密码加盐 SHA-256 哈希
- **文件上传**：浏览器直传 Blob（预签名 PUT URL），上传进度显示，支持多文件 / 拖拽上传
- **文件下载**：流式传输，正确处理 Content-Type 与文件名编码
- **文件管理**：重命名、删除、搜索、网格 / 列表视图切换
- **文件夹**：创建、进入、面包屑导航、递归删除（含子文件夹与文件）
- **预览**：图片直接预览，文本文件在线查看
- **配额控制**：每用户 500MB 存储配额，单文件 50MB 上限
- **响应式**：适配桌面与移动端

## 目录结构

```
├── index.html                         # 单页前端（登录 + 云盘界面）
├── package.json
├── edge-functions/
│   └── api/
│       └── [[default]].js             # 全部 API 路由（catch-all /api/*）
└── README.md
```

## 存储结构（Blob Keys）

```
system/secret.json                    HMAC 签名密钥（自动生成）
auth/usernames/{username}.json        用户名 → userId 映射（注册时原子占用）
auth/users/{userId}.json              用户记录（含密码哈希、存储用量）
users/{userId}/meta/{fileId}.json     文件 / 文件夹元数据
users/{userId}/data/{fileId}          文件二进制内容
```

## API

所有接口前缀 `/api`，需鉴权的接口要求 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册，返回 `{ token, user }` |
| POST | `/api/auth/login` | 登录，返回 `{ token, user }` |
| GET | `/api/auth/me` | 获取当前用户信息 |
| GET | `/api/files?path=/` | 列出指定目录下的文件与文件夹 |
| POST | `/api/files/upload-init` | 获取预签名上传 URL |
| POST | `/api/files/upload-complete` | 确认上传并写入元数据 |
| GET | `/api/files/:id` | 获取单个文件元数据 |
| GET | `/api/files/:id/download` | 下载文件（流式） |
| PATCH | `/api/files/:id` | 重命名 / 移动 |
| DELETE | `/api/files/:id` | 删除文件 |
| POST | `/api/folders` | 创建文件夹 |
| DELETE | `/api/folders/:id` | 递归删除文件夹及其内容 |
| GET | `/api/user/stats` | 存储用量统计 |
| GET | `/api/health` | 健康检查 |

### 上传流程

大文件通过预签名 URL 直传 Blob，不经过边缘函数，不受函数请求体大小限制：

```
1. POST /api/files/upload-init { name, size, type, path }
   → { fileId, uploadUrl, expiresAt }

2. PUT <uploadUrl>  (浏览器直接上传到 Blob)

3. POST /api/files/upload-complete { fileId, name, size, type, path }
   → { file }
```

## 部署

1. 在 [EdgeOne Pages 控制台](https://edgeone.ai/pages) 创建项目，以本目录为根部署
2. 创建名为 `cloud-drive` 的 Blob Store（或在 `[[default]].js` 中修改 `STORE_NAME`）
3. 部署完成后访问站点即可使用

[![Deploy with EdgeOne Pages](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/pages/new)

## 技术栈

- **存储**：`@edgeone/pages-blob`
- **后端**：EdgeOne Pages Edge Functions（Web Crypto API 加密）
- **前端**：原生 HTML / CSS / JS，无框架依赖
- **上传**：预签名 PUT URL 直传 + XMLHttpRequest 进度

## License

MIT

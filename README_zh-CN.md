# @edgeone/pages-blob 示例项目

用于演示 `@edgeone/pages-blob` 用法的完整 EdgeOne Pages 项目。同时包含 **Edge Functions** 和 **Cloud Functions (Node.js)** 两种运行时，通过子目录路径区分访问。

## 部署

[![使用 EdgeOne Pages 部署](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/pages/new?template=pages-blob)

在线预览：https://pages-blob.edgeone.site

## 目录结构

```
├── package.json
├── edge-functions/                     # Edge Functions 运行时
│   └── edge-app/                       # 路由前缀: /edge-app
│       ├── index.js                    # GET /edge-app（首页 + 访问计数）
│       └── api/
│           └── [[default]].js          # /edge-app/api/*（用户 CRUD + 404 兜底）
│
└── cloud-functions/                    # Node Functions 运行时
    └── node-app/                       # 路由前缀: /node-app
        ├── index.js                    # GET /node-app（首页 + 访客信息）
        └── api/
            └── [[default]].js          # /node-app/api/*（用户 CRUD + prefix 过滤 + 404 兜底）
```

## 功能特性

- Edge Functions 中的 Blob 存储读写
- Node.js Cloud Functions 中的 Blob 存储读写
- `getStore()` 通过部署凭证自动认证
- `store.set()` / `store.get()` / `store.setJSON()` / `store.delete()` 操作
- 使用 `[[default]].js` 实现 Catch-all 路由

## 部署

1. 在 EdgeOne Pages 控制台创建项目，将本目录作为项目根目录部署
2. 创建 Blob Store，名称为 `pages-blob-example`（或在代码中自定义）
3. 部署后 edge-functions 和 cloud-functions 各自路由生效，互不冲突

## 使用方法

请将下方示例中的 `<YOUR_DOMAIN>` 替换为你实际部署后的域名（例如 `https://your-project.edgeone.cool`）。

### Edge Functions（/edge-app）

```bash
# 首页 - 访问计数
curl <YOUR_DOMAIN>/edge-app

# 创建用户
curl -X POST -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@test.com"}' \
  <YOUR_DOMAIN>/edge-app/api/users

# 用户列表
curl <YOUR_DOMAIN>/edge-app/api/users

# 删除用户
curl -X DELETE <YOUR_DOMAIN>/edge-app/api/users/<ID>
```

### Node Functions（/node-app）

```bash
# 首页 - 访客信息
curl <YOUR_DOMAIN>/node-app

# 创建用户
curl -X POST -H "Content-Type: application/json" \
  -d '{"name":"Charlie","email":"charlie@test.com"}' \
  <YOUR_DOMAIN>/node-app/api/users

# 用户列表（支持 prefix 过滤）
curl "<YOUR_DOMAIN>/node-app/api/users?prefix=Ch"

# 更新用户
curl -X PUT -H "Content-Type: application/json" \
  -d '{"name":"Charlie Updated"}' \
  <YOUR_DOMAIN>/node-app/api/users/<ID>

# 删除用户
curl -X DELETE <YOUR_DOMAIN>/node-app/api/users/<ID>
```

## 许可证

MIT

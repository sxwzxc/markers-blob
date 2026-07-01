# @edgeone/pages-blob Example

A complete EdgeOne Pages project demonstrating `@edgeone/pages-blob` usage. Includes both **Edge Functions** and **Cloud Functions (Node.js)** runtimes, differentiated by subdirectory path routing.

## Deploy

[![Deploy with EdgeOne Pages](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/pages/new?template=pages-blob)

Live Demo: https://pages-blob.edgeone.site

More Templates: [EdgeOne Pages](https://edgeone.ai/pages/templates)

## Directory Structure

```
├── package.json
├── edge-functions/                     # Edge Functions runtime
│   └── edge-app/                       # Route prefix: /edge-app
│       ├── index.js                    # GET /edge-app (homepage + visit counter)
│       └── api/
│           └── [[default]].js          # /edge-app/api/* (user CRUD + 404 fallback)
│
└── cloud-functions/                    # Node Functions runtime
    └── node-app/                       # Route prefix: /node-app
        ├── index.js                    # GET /node-app (homepage + visitor info)
        └── api/
            └── [[default]].js          # /node-app/api/* (user CRUD + prefix filter + 404 fallback)
```

## Features

- Blob store read/write within Edge Functions
- Blob store read/write within Node.js Cloud Functions
- `getStore()` automatic authentication via deploy credentials
- `store.set()` / `store.get()` / `store.setJSON()` / `store.delete()` operations
- Catch-all routing with `[[default]].js`

## Deployment

1. Create a project in EdgeOne Pages console, deploy this directory as the project root
2. Create a Blob Store named `pages-blob-example` (or customize in your code)
3. After deployment, edge-functions and cloud-functions routes take effect independently

## Usage

Replace `<YOUR_DOMAIN>` below with your actual deployed domain (e.g., `https://your-project.edgeone.cool`).

### Edge Functions (/edge-app)

```bash
# Homepage - visit counter
curl <YOUR_DOMAIN>/edge-app

# Create user
curl -X POST -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@test.com"}' \
  <YOUR_DOMAIN>/edge-app/api/users

# List users
curl <YOUR_DOMAIN>/edge-app/api/users

# Delete user
curl -X DELETE <YOUR_DOMAIN>/edge-app/api/users/<ID>
```

### Node Functions (/node-app)

```bash
# Homepage - visitor info
curl <YOUR_DOMAIN>/node-app

# Create user
curl -X POST -H "Content-Type: application/json" \
  -d '{"name":"Charlie","email":"charlie@test.com"}' \
  <YOUR_DOMAIN>/node-app/api/users

# List users with prefix filter
curl "<YOUR_DOMAIN>/node-app/api/users?prefix=Ch"

# Update user
curl -X PUT -H "Content-Type: application/json" \
  -d '{"name":"Charlie Updated"}' \
  <YOUR_DOMAIN>/node-app/api/users/<ID>

# Delete user
curl -X DELETE <YOUR_DOMAIN>/node-app/api/users/<ID>
```

## License

MIT

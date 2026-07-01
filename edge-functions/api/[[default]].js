/**
 * Cloud Drive API — Edge Function (catch-all for /api/*)
 *
 * Storage layout (blob store: "cloud-drive"):
 *   system/secret.json                    HMAC signing secret (auto-generated)
 *   auth/usernames/{username}.json        { userId } — atomically claimed on register
 *   auth/users/{userId}.json              { id, username, passwordHash, salt, createdAt, storageUsed, fileCount }
 *   users/{userId}/meta/{fileId}.json     file/folder metadata
 *   users/{userId}/data/{fileId}          file binary content
 *
 * Auth: bearer token = base64url(payload).base64url(hmacSHA256(payload, secret))
 * Uploads use presigned PUT URLs (browser → blob, bypasses the function body limit).
 */
import { getStore } from "@edgeone/pages-blob";

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_NAME = "cloud-drive";
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB per file
const USER_QUOTA = 500 * 1024 * 1024; // 500 MB per user
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const UPLOAD_URL_TTL = 3600; // seconds

const store = getStore(STORE_NAME);

// Module-level cache for the HMAC secret (avoids reading blob on every request).
let cachedSecret = null;

// ── CORS ────────────────────────────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

// ── Encoding / crypto helpers ────────────────────────────────────────────────
function b64urlEncode(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function b64urlDecodeStr(str) {
  return new TextDecoder().decode(b64urlDecode(str));
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function generateId() {
  return Date.now().toString(36) + "_" + b64urlEncode(randomBytes(8));
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return b64urlEncode(hash);
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlEncode(sig);
}

/** Timing-safe string comparison to mitigate token forgery via timing leaks. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// ── Secret management ────────────────────────────────────────────────────────
async function getSecret() {
  if (cachedSecret) return cachedSecret;
  const existing = await store.get("system/secret.json", { type: "json", consistency: "strong" });
  if (existing && existing.secret) {
    cachedSecret = existing.secret;
    return cachedSecret;
  }
  const newSecret = b64urlEncode(randomBytes(32));
  await store.setJSON("system/secret.json", { secret: newSecret, createdAt: new Date().toISOString() }, { onlyIfNew: true });
  // Re-read (strong) in case another instance generated the secret concurrently.
  const confirmed = await store.get("system/secret.json", { type: "json", consistency: "strong" });
  cachedSecret = confirmed && confirmed.secret ? confirmed.secret : newSecret;
  return cachedSecret;
}

// ── Token ────────────────────────────────────────────────────────────────────
async function createToken(userId, username) {
  const payload = { uid: userId, usr: username, exp: Date.now() + TOKEN_EXPIRY_MS };
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(payloadB64, await getSecret());
  return `${payloadB64}.${sig}`;
}

async function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = await hmacSign(payloadB64, await getSecret());
  if (!timingSafeEqual(sig, expectedSig)) return null;
  try {
    const payload = JSON.parse(b64urlDecodeStr(payloadB64));
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Password ─────────────────────────────────────────────────────────────────
function generateSalt() {
  return b64urlEncode(randomBytes(16));
}

async function hashPassword(password, salt) {
  return sha256(salt + ":" + password);
}

// ── Auth middleware ──────────────────────────────────────────────────────────
async function requireAuth(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return { user: null, error: json({ error: "Authentication required" }, 401) };
  const payload = await verifyToken(match[1].trim());
  if (!payload) return { user: null, error: json({ error: "Invalid or expired token" }, 401) };
  const user = await store.get(`auth/users/${payload.uid}.json`, { type: "json" });
  if (!user || user.username !== payload.usr) {
    return { user: null, error: json({ error: "Invalid or expired token" }, 401) };
  }
  return { user, error: null };
}

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ── Validation helpers ───────────────────────────────────────────────────────
function normalizePath(path) {
  if (!path || typeof path !== "string") path = "/";
  if (!path.startsWith("/")) path = "/" + path;
  if (!path.endsWith("/")) path = path + "/";
  path = path.replace(/\/+/g, "/");
  if (path.includes("..") || path.includes("\\")) return null;
  if (path.length > 500) return null;
  return path;
}

function isValidFilename(name) {
  if (!name || typeof name !== "string") return false;
  if (name.length === 0 || name.length > 255) return false;
  // Disallow path separators, shell metacharacters, and quotes (avoids
  // both path traversal and JS/HTML injection in the frontend).
  if (/[\\/:*?"<>|'`]/.test(name)) return false;
  if (name.startsWith(".") && name !== ".") return false;
  if (name.trim() !== name) return false;
  return true;
}

function publicUser(user) {
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

async function updateUserStorage(user, sizeDelta, countDelta) {
  const key = `auth/users/${user.id}.json`;
  const fresh = await store.get(key, { type: "json" });
  if (!fresh) return;
  fresh.storageUsed = Math.max(0, (fresh.storageUsed || 0) + sizeDelta);
  fresh.fileCount = Math.max(0, (fresh.fileCount || 0) + countDelta);
  await store.setJSON(key, fresh);
}

// ── Handlers: Auth ───────────────────────────────────────────────────────────
async function handleRegister(body) {
  const { username, password } = body || {};
  if (!username || !password) return json({ error: "用户名和密码不能为空" }, 400);
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username))
    return json({ error: "用户名需为 3-32 位，仅含字母、数字、下划线、连字符" }, 400);
  if (password.length < 6 || password.length > 64)
    return json({ error: "密码长度需为 6-64 位" }, 400);

  const lowerName = username.toLowerCase();
  const usernameKey = `auth/usernames/${lowerName}.json`;

  // Check + atomic claim
  const existing = await store.get(usernameKey, { type: "json", consistency: "strong" });
  if (existing) return json({ error: "用户名已被占用" }, 409);

  const userId = generateId();
  await store.setJSON(usernameKey, { userId }, { onlyIfNew: true });
  const after = await store.get(usernameKey, { type: "json", consistency: "strong" });
  if (!after || after.userId !== userId) return json({ error: "用户名已被占用" }, 409);

  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);
  const now = new Date().toISOString();
  const userRecord = {
    id: userId,
    username,
    passwordHash,
    salt,
    createdAt: now,
    storageUsed: 0,
    fileCount: 0,
  };
  await store.setJSON(`auth/users/${userId}.json`, userRecord);

  const token = await createToken(userId, username);
  return json({ token, user: publicUser(userRecord) }, 201);
}

async function handleLogin(body) {
  const { username, password } = body || {};
  if (!username || !password) return json({ error: "用户名和密码不能为空" }, 400);

  const lowerName = username.toLowerCase();
  const nameRecord = await store.get(`auth/usernames/${lowerName}.json`, { type: "json" });
  if (!nameRecord) return json({ error: "用户名或密码错误" }, 401);

  const user = await store.get(`auth/users/${nameRecord.userId}.json`, { type: "json" });
  if (!user) return json({ error: "用户名或密码错误" }, 401);

  const hash = await hashPassword(password, user.salt);
  if (!timingSafeEqual(hash, user.passwordHash)) return json({ error: "用户名或密码错误" }, 401);

  const token = await createToken(user.id, user.username);
  return json({ token, user: publicUser(user) });
}

async function handleMe(user) {
  return json({ user: publicUser(user) });
}

// ── Handlers: Files ──────────────────────────────────────────────────────────
async function handleListFiles(user, searchParams) {
  const path = normalizePath(searchParams.get("path") || "/");
  if (path === null) return json({ error: "无效的路径" }, 400);

  const { blobs } = await store.list({ prefix: `users/${user.id}/meta/` });
  const metas = await Promise.all(
    blobs.map((b) => store.get(b.key, { type: "json" }).catch(() => null))
  );

  const items = metas
    .filter((m) => m && m.path === path)
    .sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.name.localeCompare(b.name, "zh-Hans");
    });

  return json({ items, path });
}

async function handleGetFile(user, fileId) {
  const meta = await store.get(`users/${user.id}/meta/${fileId}.json`, { type: "json" });
  if (!meta) return json({ error: "文件不存在" }, 404);
  return json({ file: meta });
}

async function handleUploadInit(user, body) {
  const { name, size, type, path } = body || {};
  if (!name || !isValidFilename(name)) return json({ error: "无效的文件名" }, 400);
  if (typeof size !== "number" || size <= 0) return json({ error: "无效的文件大小" }, 400);
  if (size > MAX_FILE_SIZE)
    return json({ error: `文件过大，单文件上限 ${formatBytes(MAX_FILE_SIZE)}` }, 413);

  const folderPath = normalizePath(path);
  if (folderPath === null) return json({ error: "无效的路径" }, 400);

  if ((user.storageUsed || 0) + size > USER_QUOTA) {
    const avail = Math.max(0, USER_QUOTA - (user.storageUsed || 0));
    return json({ error: `存储空间不足，剩余 ${formatBytes(avail)}` }, 413);
  }

  const fileId = generateId();
  const dataKey = `users/${user.id}/data/${fileId}`;
  const { url, expiresAt } = await store.createUploadUrl(dataKey, {
    expireSeconds: UPLOAD_URL_TTL,
  });

  return json({ fileId, uploadUrl: url, expiresAt, method: "PUT" });
}

async function handleUploadComplete(user, body) {
  const { fileId, name, size, type, path } = body || {};
  if (!fileId) return json({ error: "缺少 fileId" }, 400);
  if (!name || !isValidFilename(name)) return json({ error: "无效的文件名" }, 400);

  const folderPath = normalizePath(path);
  if (folderPath === null) return json({ error: "无效的路径" }, 400);

  const fileSize = typeof size === "number" && size > 0 ? size : 0;
  if (fileSize > MAX_FILE_SIZE) return json({ error: "文件过大" }, 413);
  if ((user.storageUsed || 0) + fileSize > USER_QUOTA) return json({ error: "存储空间不足" }, 413);

  // Verify the blob was actually uploaded by the browser.
  const dataKey = `users/${user.id}/data/${fileId}`;
  const check = await store.getWithHeaders(dataKey, { consistency: "strong" });
  if (!check) return json({ error: "未检测到已上传的文件数据，请重试上传" }, 400);

  const now = new Date().toISOString();
  const meta = {
    id: fileId,
    name,
    size: fileSize,
    type: type || "application/octet-stream",
    path: folderPath,
    isFolder: false,
    createdAt: now,
    updatedAt: now,
  };
  await store.setJSON(`users/${user.id}/meta/${fileId}.json`, meta);
  await updateUserStorage(user, fileSize, 1);

  return json({ file: meta }, 201);
}

async function handleDownload(user, fileId) {
  const meta = await store.get(`users/${user.id}/meta/${fileId}.json`, { type: "json" });
  if (!meta || meta.isFolder) return json({ error: "文件不存在" }, 404);

  const stream = await store.get(`users/${user.id}/data/${fileId}`, { type: "stream" });
  if (!stream) return json({ error: "文件数据不存在" }, 404);

  const safeName = encodeURIComponent(meta.name);
  const headers = {
    "Content-Type": meta.type || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${meta.name.replace(/"/g, "_")}"; filename*=UTF-8''${safeName}`,
    "Content-Length": String(meta.size || 0),
    "Cache-Control": "private, no-cache",
    ...corsHeaders,
  };
  return new Response(stream, { headers });
}

async function handleUpdateFile(user, fileId, body) {
  const metaKey = `users/${user.id}/meta/${fileId}.json`;
  const meta = await store.get(metaKey, { type: "json" });
  if (!meta) return json({ error: "文件不存在" }, 404);

  if (body && body.name !== undefined) {
    if (!isValidFilename(body.name)) return json({ error: "无效的文件名" }, 400);
    meta.name = body.name;
  }
  if (body && body.path !== undefined) {
    const newPath = normalizePath(body.path);
    if (newPath === null) return json({ error: "无效的路径" }, 400);
    meta.path = newPath;
  }
  meta.updatedAt = new Date().toISOString();
  await store.setJSON(metaKey, meta);
  return json({ file: meta });
}

async function handleDeleteFile(user, fileId) {
  const metaKey = `users/${user.id}/meta/${fileId}.json`;
  const meta = await store.get(metaKey, { type: "json" });
  if (!meta) return json({ error: "不存在" }, 404);

  if (meta.isFolder) {
    // Recursively delete the folder and all descendants.
    const folderFullPath = meta.path + meta.name + "/";
    const { blobs } = await store.list({ prefix: `users/${user.id}/meta/` });
    const allMetas = await Promise.all(
      blobs.map((b) => store.get(b.key, { type: "json" }).then((m) => ({ key: b.key, meta: m })).catch(() => null))
    );

    let sizeFreed = 0;
    let countFreed = 0;
    for (const item of allMetas) {
      if (!item || !item.meta) continue;
      const m = item.meta;
      const isFolderItself = m.id === fileId;
      const isDescendant = typeof m.path === "string" && m.path.startsWith(folderFullPath);
      if (!isFolderItself && !isDescendant) continue;
      if (!m.isFolder) {
        await store.delete(`users/${user.id}/data/${m.id}`).catch(() => {});
        sizeFreed += m.size || 0;
        countFreed += 1;
      }
      await store.delete(item.key).catch(() => {});
    }
    await updateUserStorage(user, -sizeFreed, -countFreed);
    return json({ ok: true, freed: { size: sizeFreed, count: countFreed } });
  }

  // Regular file
  await store.delete(`users/${user.id}/data/${fileId}`).catch(() => {});
  await store.delete(metaKey);
  await updateUserStorage(user, -(meta.size || 0), -1);
  return json({ ok: true });
}

// ── Handlers: Folders ────────────────────────────────────────────────────────
async function handleCreateFolder(user, body) {
  const { name, path } = body || {};
  if (!name || !isValidFilename(name)) return json({ error: "无效的文件夹名" }, 400);
  const folderPath = normalizePath(path);
  if (folderPath === null) return json({ error: "无效的路径" }, 400);

  const folderId = generateId();
  const now = new Date().toISOString();
  const folder = {
    id: folderId,
    name,
    path: folderPath,
    isFolder: true,
    size: 0,
    type: "folder",
    createdAt: now,
    updatedAt: now,
  };
  await store.setJSON(`users/${user.id}/meta/${folderId}.json`, folder);
  return json({ file: folder }, 201);
}

// ── Handlers: User stats ─────────────────────────────────────────────────────
async function handleStats(user) {
  return json({
    storageUsed: user.storageUsed || 0,
    fileCount: user.fileCount || 0,
    quota: USER_QUOTA,
    maxFileSize: MAX_FILE_SIZE,
  });
}

// ── Router ───────────────────────────────────────────────────────────────────
export default async function onRequest(context) {
  const request = context.request;
  const method = request.method;

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);
  const path = (url.pathname.replace(/^\/api/, "") || "/").replace(/\/+$/, "") || "/";

  try {
    // ── Public routes ──
    if (path === "/health" && method === "GET") {
      return json({ ok: true, service: "cloud-drive", time: new Date().toISOString() });
    }

    if (path === "/auth/register" && method === "POST") {
      const body = await parseJsonBody(request);
      if (!body) return json({ error: "无效的请求体" }, 400);
      return await handleRegister(body);
    }

    if (path === "/auth/login" && method === "POST") {
      const body = await parseJsonBody(request);
      if (!body) return json({ error: "无效的请求体" }, 400);
      return await handleLogin(body);
    }

    // ── Authenticated routes ──
    // /auth/me
    if (path === "/auth/me" && method === "GET") {
      const { user, error } = await requireAuth(request);
      if (error) return error;
      return await handleMe(user);
    }

    // /files (list)
    if (path === "/files" && method === "GET") {
      const { user, error } = await requireAuth(request);
      if (error) return error;
      return await handleListFiles(user, url.searchParams);
    }

    // /files/upload-init
    if (path === "/files/upload-init" && method === "POST") {
      const { user, error } = await requireAuth(request);
      if (error) return error;
      const body = await parseJsonBody(request);
      if (!body) return json({ error: "无效的请求体" }, 400);
      return await handleUploadInit(user, body);
    }

    // /files/upload-complete
    if (path === "/files/upload-complete" && method === "POST") {
      const { user, error } = await requireAuth(request);
      if (error) return error;
      const body = await parseJsonBody(request);
      if (!body) return json({ error: "无效的请求体" }, 400);
      return await handleUploadComplete(user, body);
    }

    // /files/:id
    const fileMatch = path.match(/^\/files\/([^/]+)$/);
    if (fileMatch) {
      const { user, error } = await requireAuth(request);
      if (error) return error;
      const fileId = decodeURIComponent(fileMatch[1]);
      if (method === "GET") return await handleGetFile(user, fileId);
      if (method === "PATCH") {
        const body = await parseJsonBody(request);
        if (!body) return json({ error: "无效的请求体" }, 400);
        return await handleUpdateFile(user, fileId, body);
      }
      if (method === "DELETE") return await handleDeleteFile(user, fileId);
    }

    // /files/:id/download
    const dlMatch = path.match(/^\/files\/([^/]+)\/download$/);
    if (dlMatch && method === "GET") {
      const { user, error } = await requireAuth(request);
      if (error) return error;
      return await handleDownload(user, decodeURIComponent(dlMatch[1]));
    }

    // /folders
    if (path === "/folders" && method === "POST") {
      const { user, error } = await requireAuth(request);
      if (error) return error;
      const body = await parseJsonBody(request);
      if (!body) return json({ error: "无效的请求体" }, 400);
      return await handleCreateFolder(user, body);
    }

    // /folders/:id (delete — recursive)
    const folderMatch = path.match(/^\/folders\/([^/]+)$/);
    if (folderMatch && method === "DELETE") {
      const { user, error } = await requireAuth(request);
      if (error) return error;
      return await handleDeleteFile(user, decodeURIComponent(folderMatch[1]));
    }

    // /user/stats
    if (path === "/user/stats" && method === "GET") {
      const { user, error } = await requireAuth(request);
      if (error) return error;
      return await handleStats(user);
    }

    // 404
    return json({ error: "Not Found", path, method }, 404);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return json({ error: "Internal Server Error", message }, 500);
  }
}

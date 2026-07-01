/**
 * Node Function: Catch-all route
 * Handles all /node-app/api/* requests, including user CRUD (with prefix filter, PUT) and 404 fallback
 */
import { getStore } from "@edgeone/pages-blob";

const store = getStore("functions-test");
const USERS_KEY = "node-app/data/users.json";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default async function onRequest(context) {
  const url = new URL(context.request.url);
  const method = context.request.method;
  const path = url.pathname.replace(/^\/node-app\/api/, "");

  // POST /api/users - Create user
  if (path === "/users" && method === "POST") {
    const body = await context.request.json();
    const { name, email } = body;

    if (!name || !email) {
      return json({ error: "name and email are required" }, 400);
    }

    const data = await store.get(USERS_KEY, { type: "json" });
    const users = data || [];
    const newUser = { id: Date.now(), name, email, createdAt: new Date().toISOString() };
    users.push(newUser);
    await store.setJSON(USERS_KEY, users);
    return json(newUser, 201);
  }

  // GET /api/users - List users (supports ?prefix= filter)
  if (path === "/users" && method === "GET") {
    const prefix = url.searchParams.get("prefix");
    const data = await store.get(USERS_KEY, { type: "json" });
    let users = data || [];

    if (prefix) {
      users = users.filter((u) => u.name.startsWith(prefix));
    }

    return json({ users, total: users.length });
  }

  // Match /api/users/:id
  const userMatch = path.match(/^\/users\/(\d+)$/);

  // GET /api/users/:id - Get single user
  if (userMatch && method === "GET") {
    const id = userMatch[1];
    const data = await store.get(USERS_KEY, { type: "json" });
    const users = data || [];
    const user = users.find((u) => String(u.id) === id);

    if (!user) return json({ error: "User not found" }, 404);
    return json(user);
  }

  // PUT /api/users/:id - Update user
  if (userMatch && method === "PUT") {
    const id = userMatch[1];
    const body = await context.request.json();
    const data = await store.get(USERS_KEY, { type: "json" });
    const users = data || [];
    const idx = users.findIndex((u) => String(u.id) === id);

    if (idx === -1) return json({ error: "User not found" }, 404);
    users[idx] = { ...users[idx], ...body, updatedAt: new Date().toISOString() };
    await store.setJSON(USERS_KEY, users);
    return json(users[idx]);
  }

  // DELETE /api/users/:id - Delete user
  if (userMatch && method === "DELETE") {
    const id = userMatch[1];
    const data = await store.get(USERS_KEY, { type: "json" });
    const users = data || [];
    const idx = users.findIndex((u) => String(u.id) === id);

    if (idx === -1) return json({ error: "User not found" }, 404);
    const deleted = users.splice(idx, 1)[0];
    await store.setJSON(USERS_KEY, users);
    return json({ message: "Deleted", user: deleted });
  }

  // Fallback 404
  return json({ error: "Not Found", path: url.pathname, method, requestId: context.uuid }, 404);
}

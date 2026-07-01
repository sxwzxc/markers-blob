/**
 * Node Function: node-app homepage
 * Route: /node-app
 */
import { getStore } from "@edgeone/pages-blob";

export default async function onRequest(context) {
  const store = getStore("functions-test");

  const info = {
    uuid: context.uuid,
    clientIp: context.clientIp,
    geo: context.geo,
    region: context.region,
    timestamp: new Date().toISOString(),
  };

  await store.setJSON("node-app/last-visit.json", info);

  return new Response(
    JSON.stringify({
      message: "Hello from Node.js Cloud Functions!",
      requestId: context.uuid,
      visitor: info,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
}

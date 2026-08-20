export function deriveRpcEndpoints(input) {
  let rpc;
  try {
    rpc = new URL(String(input).trim());
  } catch {
    throw new Error("Некорректный HTTP RPC-адрес.");
  }

  if (rpc.protocol !== "https:") {
    throw new Error("RPC должен начинаться с https://.");
  }
  const hostname = rpc.hostname.toLowerCase();
  const isHelius = hostname === "helius-rpc.com" || hostname.endsWith(".helius-rpc.com");
  const isQuickNode = hostname === "quiknode.pro" || hostname.endsWith(".quiknode.pro");
  let apiKey;
  let provider;
  if (isHelius) {
    provider = "Helius";
    apiKey = rpc.searchParams.get("api-key")?.trim();
    if (!apiKey) throw new Error("В Helius RPC отсутствует параметр ?api-key=... .");
  } else if (isQuickNode) {
    provider = "QuickNode";
    const pathParts = rpc.pathname.split("/").filter(Boolean);
    apiKey = pathParts.at(-1)?.trim();
    if (!apiKey) throw new Error("В QuickNode RPC отсутствует токен доступа в пути URL.");
  } else {
    throw new Error("Поддерживаются RPC-провайдеры Helius и QuickNode.");
  }

  const ws = new URL(rpc.href);
  ws.protocol = "wss:";
  return { rpcUrl: rpc.href, wsUrl: ws.href, apiKey, provider };
}

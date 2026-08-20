import test from "node:test";
import assert from "node:assert/strict";
import { deriveRpcEndpoints } from "../public/endpoints.js";

test("из Helius HTTP RPC извлекается ключ и строится WSS", () => {
  const result = deriveRpcEndpoints("https://mainnet.helius-rpc.com/?api-key=test-key-123");
  assert.equal(result.rpcUrl, "https://mainnet.helius-rpc.com/?api-key=test-key-123");
  assert.equal(result.wsUrl, "wss://mainnet.helius-rpc.com/?api-key=test-key-123");
  assert.equal(result.apiKey, "test-key-123");
  assert.equal(result.provider, "Helius");
});

test("Helius RPC без API-ключа отклоняется", () => {
  assert.throws(() => deriveRpcEndpoints("https://mainnet.helius-rpc.com/"), /api-key/);
});

test("из QuickNode HTTP RPC извлекается токен пути и строится WSS", () => {
  const result = deriveRpcEndpoints("https://demo.solana-mainnet.quiknode.pro/example-token-456/");
  assert.equal(result.rpcUrl, "https://demo.solana-mainnet.quiknode.pro/example-token-456/");
  assert.equal(result.wsUrl, "wss://demo.solana-mainnet.quiknode.pro/example-token-456/");
  assert.equal(result.apiKey, "example-token-456");
  assert.equal(result.provider, "QuickNode");
});

test("QuickNode RPC без токена пути отклоняется", () => {
  assert.throws(() => deriveRpcEndpoints("https://demo.solana-mainnet.quiknode.pro/"), /токен доступа/);
});

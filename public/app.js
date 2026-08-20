import { analyzeTransaction } from "./analyzer.js";
import { deriveRpcEndpoints } from "./endpoints.js";

const STORAGE_KEY = "solana-live-screener-config-v1";
const MAX_ROWS = 2000;
const MAX_SEEN = 25000;
const WORKERS = 6;
const MAX_QUEUE = 5000;
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

const elements = Object.fromEntries([
  "tokenMint", "rpcUrl", "showEndpoints", "rememberEndpoints",
  "startButton", "stopButton", "clearButton", "settingsToggle", "settingsBody",
  "notice", "connectionBadge", "poolCount", "subscriptionCount", "transactionCount",
  "startSlot", "queueStatus", "transactionRows", "emptyRow",
].map((id) => [id, document.getElementById(id)]));

const state = {
  running: false, session: 0, ws: null, reconnectTimer: null, refreshTimer: null,
  startSlot: 0, watched: new Map(), pendingSubscriptions: new Map(), subscriptions: new Map(),
  failedSubscriptions: new Map(),
  queue: [], workers: 0, seen: new Set(), transactions: 0, requestId: 1,
  rpcUrl: "", wsUrl: "", mint: "",
};

restoreConfig();
bindEvents();
showNotice("Введите mint токена и HTTP RPC Helius или QuickNode, затем запустите скринер.");

function bindEvents() {
  elements.startButton.addEventListener("click", start);
  elements.stopButton.addEventListener("click", () => stop("Скринер остановлен."));
  elements.clearButton.addEventListener("click", clearRows);
  elements.showEndpoints.addEventListener("change", () => {
    elements.rpcUrl.type = elements.showEndpoints.checked ? "text" : "password";
  });
  elements.settingsToggle.addEventListener("click", () => {
    const expanded = elements.settingsToggle.getAttribute("aria-expanded") === "true";
    elements.settingsToggle.setAttribute("aria-expanded", String(!expanded));
    elements.settingsToggle.textContent = expanded ? "Развернуть" : "Свернуть";
    elements.settingsBody.hidden = expanded;
  });
  window.addEventListener("beforeunload", closeConnections);
}

async function start() {
  if (state.running) return;
  let settings;
  try { settings = validateSettings(); }
  catch (error) { showNotice(error.message, "error"); return; }

  state.running = true;
  state.session += 1;
  state.rpcUrl = settings.rpcUrl;
  state.wsUrl = settings.wsUrl;
  state.mint = settings.mint;
  state.startSlot = 0;
  state.watched.clear();
  state.pendingSubscriptions.clear();
  state.subscriptions.clear();
  state.failedSubscriptions.clear();
  state.queue.length = 0;
  state.seen.clear();
  state.transactions = 0;
  state.requestId = 1;
  updateControls(); updateStats();
  setBadge("wait", "Подключение");
  showNotice("Проверяю RPC и фиксирую стартовый slot…");
  saveConfig();

  const session = state.session;
  try {
    state.startSlot = await rpc("getSlot", [{ commitment: "confirmed" }]);
    if (!isCurrent(session)) return;
    elements.startSlot.textContent = String(state.startSlot);
    state.watched.set(state.mint, "mint токена");
    try { await discoverPools(); }
    catch (error) { showNotice(`DexScreener временно недоступен: ${safeMessage(error)}. Продолжаю подписку на mint.`, "warning"); }
    if (!isCurrent(session)) return;
    updateStats();
    connectWebSocket(session);
    state.refreshTimer = window.setInterval(() => refreshPools(session), 60_000);
  } catch (error) {
    stop(`Не удалось запустить: ${safeMessage(error)}`, "error");
  }
}

function stop(message = "Скринер остановлен.", kind = "normal") {
  if (state.running) state.session += 1;
  state.running = false;
  closeConnections();
  state.pendingSubscriptions.clear(); state.subscriptions.clear(); state.failedSubscriptions.clear(); state.queue.length = 0;
  updateControls(); updateStats();
  setBadge(kind === "error" ? "error" : "offline", kind === "error" ? "Ошибка" : "Остановлен");
  showNotice(message, kind);
}

function closeConnections() {
  if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  state.reconnectTimer = null; state.refreshTimer = null;
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
}

function connectWebSocket(session) {
  if (!isCurrent(session)) return;
  setBadge("wait", "WebSocket");
  const socket = new WebSocket(state.wsUrl);
  state.ws = socket;
  socket.addEventListener("open", () => {
    if (!isCurrent(session) || state.ws !== socket) return;
    state.pendingSubscriptions.clear(); state.subscriptions.clear(); state.failedSubscriptions.clear();
    setBadge("online", "В эфире");
    showNotice(`Подключено. Отслеживаю только slots > ${state.startSlot}.`, "success");
    subscribeAll(socket);
  });
  socket.addEventListener("message", (event) => {
    if (isCurrent(session) && state.ws === socket) handleSocketMessage(event.data);
  });
  socket.addEventListener("error", () => {
    if (isCurrent(session)) showNotice("Ошибка WebSocket. Выполняю переподключение…", "warning");
  });
  socket.addEventListener("close", () => {
    if (!isCurrent(session) || state.ws !== socket) return;
    state.ws = null; state.pendingSubscriptions.clear(); state.subscriptions.clear(); state.failedSubscriptions.clear();
    updateStats(); setBadge("wait", "Переподключение");
    state.reconnectTimer = window.setTimeout(() => connectWebSocket(session), 2000);
  });
}

function subscribeAll(socket) {
  for (const [address, label] of state.watched) subscribeAddress(socket, address, label);
}

function subscribeAddress(socket, address, label) {
  if (socket.readyState !== WebSocket.OPEN) return;
  if ([...state.pendingSubscriptions.values()].some((item) => item.address === address)) return;
  if ([...state.subscriptions.values()].some((item) => item.address === address)) return;
  const id = state.requestId++;
  state.pendingSubscriptions.set(id, { address, label });
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [address] }, { commitment: "confirmed" }] }));
}

function handleSocketMessage(raw) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (message.id != null) {
    const request = state.pendingSubscriptions.get(message.id);
    state.pendingSubscriptions.delete(message.id);
    if (!request) return;
    if (message.error) {
      const details = message.error.message ?? JSON.stringify(message.error);
      const code = message.error.code ?? "unknown";
      state.failedSubscriptions.set(request.address, `[${code}] ${details}`);
      showNotice(`Ошибка подписки «${request.label}» (${short(request.address, 5)}) — [${code}] ${details}; активно ${state.subscriptions.size}/${state.watched.size}, ошибок ${state.failedSubscriptions.size}.`, "warning");
    } else {
      state.subscriptions.set(message.result, request);
      state.failedSubscriptions.delete(request.address);
    }
    updateStats(); return;
  }
  if (message.method !== "logsNotification") return;
  const context = message.params?.result?.context ?? {};
  const value = message.params?.result?.value ?? {};
  const slot = Number(context.slot ?? 0);
  const signature = String(value.signature ?? "");
  if (!signature || slot <= state.startSlot || state.seen.has(signature)) return;
  rememberSignature(signature);
  const subscription = state.subscriptions.get(message.params?.subscription);
  enqueue({ signature, slot, logError: value.err, source: subscription?.label ?? "mint/pool" });
}

function enqueue(item) {
  if (state.queue.length >= MAX_QUEUE) {
    showNotice("Очередь RPC переполнена: транзакция пропущена. Проверьте лимиты тарифа RPC.", "warning");
    return;
  }
  state.queue.push(item); updateQueue(); pumpQueue();
}

function pumpQueue() {
  while (state.running && state.workers < WORKERS && state.queue.length) {
    const item = state.queue.shift();
    state.workers += 1; updateQueue();
    processTransaction(item, state.session)
      .catch((error) => showNotice(`Не удалось обработать ${short(item.signature)}: ${safeMessage(error)}`, "warning"))
      .finally(() => { state.workers -= 1; updateQueue(); pumpQueue(); });
  }
}

async function processTransaction(item, session) {
  let transaction = null;
  for (let attempt = 0; attempt < 4 && isCurrent(session); attempt += 1) {
    transaction = await rpc("getTransaction", [item.signature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (transaction) break;
    await delay(450 * (attempt + 1));
  }
  if (!transaction || !isCurrent(session)) return;
  const operations = analyzeTransaction(transaction, state.mint);
  for (const operation of operations) appendRow({
    ...operation, slot: transaction.slot ?? item.slot, signature: item.signature,
    blockTime: transaction.blockTime,
    status: transaction.meta?.err == null && item.logError == null ? "SUCCESS" : "ERROR",
  });
  if (operations.length) { state.transactions += 1; updateStats(); }
}

async function rpc(method, params, maxAttempts = 6) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(state.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: `${Date.now()}-${attempt}`, method, params }) });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        throw error;
      }
      const payload = await response.json();
      if (payload.error) {
        const error = new Error(payload.error.message ?? `RPC ${payload.error.code}`);
        error.rpcCode = payload.error.code;
        if (payload.error.code === 429 || payload.error.code === -32005) error.status = 429;
        throw error;
      }
      return payload.result;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof TypeError || RETRYABLE_HTTP.has(error.status);
      if (!retryable || attempt === maxAttempts - 1) throw error;
      const wait = error.retryAfter ?? Math.min(500 * (2 ** attempt), 8000) + Math.floor(Math.random() * 250);
      if (attempt > 0) showNotice(`RPC ограничил запросы. Повтор через ${(wait / 1000).toFixed(1)} с…`, "warning");
      await delay(wait);
    }
  }
  throw lastError;
}

async function discoverPools() {
  const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(state.mint)}`);
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  const pairs = await response.json();
  if (!Array.isArray(pairs)) throw new Error("неожиданный ответ DexScreener");
  for (const pair of pairs) if (pair?.pairAddress) state.watched.set(String(pair.pairAddress), pair.dexId ? `${pair.dexId} pool` : "DEX pool");
}

async function refreshPools(session) {
  if (!isCurrent(session)) return;
  const before = new Set(state.watched.keys());
  try {
    await discoverPools();
    if (!isCurrent(session)) return;
    updateStats();
    if (state.ws?.readyState === WebSocket.OPEN) {
      for (const [address, label] of state.watched) if (!before.has(address)) subscribeAddress(state.ws, address, label);
    }
  } catch (error) { showNotice(`Не удалось обновить список пулов: ${safeMessage(error)}`, "warning"); }
}

function validateSettings() {
  const mint = elements.tokenMint.value.trim();
  const rpcUrl = elements.rpcUrl.value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error("Укажите корректный Solana mint (base58, 32–44 символа).");
  return { mint, ...deriveRpcEndpoints(rpcUrl) };
}

function appendRow(data) {
  elements.emptyRow?.remove();
  const row = document.createElement("tr");
  const values = [timeText(data.blockTime), data.status, data.direction, data.amount, data.swapSol, data.solBefore, data.solAfter, data.solDelta, data.networkFeeSol, data.dex, short(data.trader), String(data.slot)];
  values.forEach((value, index) => {
    const cell = document.createElement("td");
    cell.textContent = value;
    if ([3, 4, 5, 6, 7, 8, 10, 11].includes(index)) cell.classList.add("mono");
    if (index === 1) cell.classList.add(data.status === "SUCCESS" ? "status-ok" : "status-error");
    if (index === 2) {
      cell.textContent = "";
      const badge = document.createElement("span"); badge.textContent = value; badge.className = `operation ${operationClass(value)}`; cell.append(badge);
    }
    if (index === 7 && String(value) !== "0") cell.classList.add(String(value).startsWith("+") ? "positive" : "negative");
    row.append(cell);
  });
  const signatureCell = document.createElement("td"); signatureCell.className = "mono";
  const link = document.createElement("a"); link.className = "signature-link"; link.textContent = short(data.signature, 7);
  link.href = `https://solscan.io/tx/${encodeURIComponent(data.signature)}`; link.target = "_blank"; link.rel = "noopener noreferrer"; link.title = data.signature;
  signatureCell.append(link); row.append(signatureCell); elements.transactionRows.prepend(row);
  while (elements.transactionRows.rows.length > MAX_ROWS) elements.transactionRows.deleteRow(-1);
}

function clearRows() {
  elements.transactionRows.replaceChildren();
  const row = document.createElement("tr"); row.id = "emptyRow";
  const cell = document.createElement("td"); cell.colSpan = 13; cell.className = "empty-state"; cell.textContent = "Новые транзакции появятся здесь после запуска.";
  row.append(cell); elements.transactionRows.append(row); elements.emptyRow = row;
}

function updateControls() {
  elements.startButton.disabled = state.running; elements.stopButton.disabled = !state.running;
  for (const input of [elements.tokenMint, elements.rpcUrl]) input.disabled = state.running;
}
function updateStats() {
  elements.poolCount.textContent = String(state.watched.size);
  elements.subscriptionCount.textContent = `${state.subscriptions.size}/${state.watched.size}${state.failedSubscriptions.size ? ` · ⚠ ${state.failedSubscriptions.size}` : ""}`;
  elements.transactionCount.textContent = String(state.transactions); updateQueue();
}
function updateQueue() { elements.queueStatus.textContent = `Очередь: ${state.queue.length} · обработка: ${state.workers}`; }
function setBadge(kind, label) { elements.connectionBadge.className = `badge badge-${kind}`; elements.connectionBadge.lastChild.textContent = ` ${label}`; }
function showNotice(message, kind = "normal") { elements.notice.textContent = message; elements.notice.className = `notice notice-visible${kind === "normal" ? "" : ` notice-${kind}`}`; }

function saveConfig() {
  if (!elements.rememberEndpoints.checked) { localStorage.removeItem(STORAGE_KEY); return; }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ mint: state.mint, rpcUrl: state.rpcUrl }));
}
function restoreConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (!saved) return;
    elements.tokenMint.value = saved.mint ?? ""; elements.rpcUrl.value = saved.rpcUrl ?? ""; elements.rememberEndpoints.checked = true;
  } catch { localStorage.removeItem(STORAGE_KEY); }
}
function rememberSignature(signature) { state.seen.add(signature); if (state.seen.size > MAX_SEEN) state.seen.delete(state.seen.values().next().value); }
function isCurrent(session) { return state.running && session === state.session; }
function delay(ms) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
function safeMessage(error) { return error instanceof Error ? error.message : String(error); }
function short(value, size = 5) { const text = String(value ?? "unknown"); return text.length > size * 2 + 1 ? `${text.slice(0, size)}…${text.slice(-size)}` : text; }
function timeText(blockTime) { const date = blockTime ? new Date(blockTime * 1000) : new Date(); return date.toLocaleTimeString("ru-RU", { hour12: false }); }
function parseRetryAfter(value) { if (!value) return null; const seconds = Number(value); if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000); const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null; }
function operationClass(direction) { if (direction === "BUY") return "operation-buy"; if (direction === "SELL") return "operation-sell"; if (direction === "FAILED SWAP") return "operation-failed"; return "operation-other"; }

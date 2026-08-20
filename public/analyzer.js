export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export const DEX_PROGRAMS = new Map([
  ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pump.fun"],
  ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "pumpswap"],
  ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "raydium-amm"],
  ["CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", "raydium-cpmm"],
  ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "raydium-clmm"],
  ["LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "meteora-dlmm"],
  ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "orca-whirlpool"],
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "jupiter-v6"],
]);

export function analyzeTransaction(transaction, targetMint) {
  const meta = transaction.meta ?? {};
  const { keys, signers } = accountKeysAndSigners(transaction);
  const tokenAccounts = buildTokenAccounts(meta, keys);
  const targetAccounts = new Map(
    [...tokenAccounts].filter(([, account]) => account.mint === targetMint),
  );
  const ownerDeltas = aggregateOwnerDeltas(targetAccounts);
  const feePayer = keys[0] ?? "unknown";
  const trader = chooseTrader(signers, feePayer, ownerDeltas, targetAccounts, meta);
  const sol = solSummary(meta, keys, trader, feePayer);
  const groups = instructionGroups(transaction, meta);
  const dexGroups = groups.filter((group) => group.dex);
  const decimals = decimalsFor(targetAccounts);

  if (meta.err != null) {
    if (dexGroups.length) {
      return dexGroups.map((group) => operation({
        direction: "FAILED SWAP", amountRaw: 0n, decimals, dex: group.dex,
        trader, confidence: "exact-status", sol, swapSol: "0", instructionIndex: group.index,
      }));
    }
    return [operation({
      direction: "UNKNOWN", amountRaw: 0n, decimals, dex: "unknown",
      trader, confidence: "exact-status", sol, swapSol: "0", instructionIndex: null,
    })];
  }

  const operations = [];
  for (const group of dexGroups) {
    const flows = userTargetFlows(group.instructions, targetMint, trader, tokenAccounts);
    const solFlows = userSolFlows(group.instructions, trader, tokenAccounts);
    if (flows.buy > 0n) {
      operations.push(operation({
        direction: "BUY", amountRaw: flows.buy, decimals, dex: group.dex,
        trader, confidence: "executed-transfer", sol,
        swapSol: formatRaw(solFlows.outgoing, 9), instructionIndex: group.index,
      }));
    }
    if (flows.sell > 0n) {
      operations.push(operation({
        direction: "SELL", amountRaw: flows.sell, decimals, dex: group.dex,
        trader, confidence: "executed-transfer", sol,
        swapSol: formatRaw(solFlows.incoming, 9), instructionIndex: group.index,
      }));
    }
  }
  if (operations.length) return operations;

  const userDelta = ownerDeltas.get(trader) ?? 0n;
  if (dexGroups.length === 1 && userDelta !== 0n) {
    return [operation({
      direction: userDelta > 0n ? "BUY" : "SELL",
      amountRaw: absBigInt(userDelta), decimals, dex: dexGroups[0].dex, trader,
      confidence: "owner-net-fallback", sol, swapSol: "0", instructionIndex: dexGroups[0].index,
    })];
  }
  if (dexGroups.length) {
    return dexGroups.map((group) => operation({
      direction: "UNKNOWN", amountRaw: 0n, decimals, dex: group.dex, trader,
      confidence: "ambiguous", sol, swapSol: "0", instructionIndex: group.index,
    }));
  }
  if (userDelta !== 0n) {
    return [operation({
      direction: "TRANSFER", amountRaw: absBigInt(userDelta), decimals, dex: "transfer",
      trader, confidence: "owner-net", sol, swapSol: "0", instructionIndex: null,
    })];
  }
  return [];
}

function operation({ direction, amountRaw, decimals, dex, trader, confidence, sol, swapSol, instructionIndex }) {
  return {
    direction,
    amount: formatRaw(amountRaw, decimals),
    amountRaw: amountRaw.toString(),
    decimals,
    dex,
    trader,
    confidence,
    solBefore: sol.before,
    solAfter: sol.after,
    solDelta: sol.delta,
    networkFeeSol: sol.fee,
    swapSol,
    instructionIndex,
  };
}

function accountKeysAndSigners(transaction) {
  const message = transaction.transaction?.message ?? {};
  const keys = [];
  const signers = [];
  for (const item of message.accountKeys ?? []) {
    if (typeof item === "string") {
      keys.push(item);
    } else {
      const pubkey = String(item.pubkey ?? "");
      keys.push(pubkey);
      if (item.signer) signers.push(pubkey);
    }
  }
  const loaded = transaction.meta?.loadedAddresses ?? {};
  for (const pubkey of [...(loaded.writable ?? []), ...(loaded.readonly ?? [])]) {
    if (!keys.includes(pubkey)) keys.push(pubkey);
  }
  if (!signers.length && keys.length) {
    const required = Number(message.header?.numRequiredSignatures ?? 1);
    signers.push(...keys.slice(0, required));
  }
  return { keys, signers };
}

function buildTokenAccounts(meta, keys) {
  const accounts = new Map();
  for (const [side, field] of [["pre", "preTokenBalances"], ["post", "postTokenBalances"]]) {
    for (const balance of meta[field] ?? []) {
      const index = Number(balance.accountIndex ?? -1);
      if (index < 0 || index >= keys.length) continue;
      const pubkey = keys[index];
      const token = balance.uiTokenAmount ?? {};
      const account = accounts.get(pubkey) ?? {
        pubkey,
        owner: balance.owner ?? null,
        mint: String(balance.mint ?? ""),
        decimals: Number(token.decimals ?? 0),
        preRaw: 0n,
        postRaw: 0n,
      };
      account.owner = balance.owner ?? account.owner;
      account.decimals = Number(token.decimals ?? account.decimals);
      account[`${side}Raw`] = BigInt(token.amount ?? "0");
      accounts.set(pubkey, account);
    }
  }
  return accounts;
}

function aggregateOwnerDeltas(accounts) {
  const result = new Map();
  for (const account of accounts.values()) {
    if (!account.owner) continue;
    const delta = account.postRaw - account.preRaw;
    result.set(account.owner, (result.get(account.owner) ?? 0n) + delta);
  }
  return result;
}

function chooseTrader(signers, feePayer, ownerDeltas, accounts, meta) {
  const candidates = [...ownerDeltas].filter(([owner, delta]) => delta !== 0n && signers.includes(owner)).map(([owner]) => owner);
  if (candidates.includes(feePayer)) return feePayer;
  if (candidates.length) return candidates[0];
  const owners = new Set([...accounts.values()].map((account) => account.owner).filter(Boolean));
  for (const authority of transferAuthorities(meta)) {
    if (signers.includes(authority) && owners.has(authority)) return authority;
  }
  for (const signer of signers) if (owners.has(signer)) return signer;
  return feePayer !== "unknown" ? feePayer : (signers[0] ?? "unknown");
}

function transferAuthorities(meta) {
  const result = [];
  for (const group of meta.innerInstructions ?? []) {
    for (const instruction of group.instructions ?? []) {
      const authority = instruction.parsed?.info?.authority;
      if (authority) result.push(String(authority));
    }
  }
  return result;
}

function instructionGroups(transaction, meta) {
  const top = transaction.transaction?.message?.instructions ?? [];
  const innerByIndex = new Map((meta.innerInstructions ?? []).map((group) => [Number(group.index), group.instructions ?? []]));
  return top.map((topInstruction, index) => {
    const inner = innerByIndex.get(index) ?? [];
    const programIds = [programId(topInstruction), ...inner.map(programId)];
    const names = [...new Set(programIds.filter((id) => DEX_PROGRAMS.has(id)).map((id) => DEX_PROGRAMS.get(id)))];
    return { index, dex: names.join("+"), instructions: [topInstruction, ...inner] };
  });
}

function programId(instruction) {
  const value = instruction.programId ?? "";
  return typeof value === "object" ? String(value.pubkey ?? "") : String(value);
}

function parsedTransfer(instruction) {
  const parsed = instruction.parsed ?? {};
  if (!["transfer", "transferChecked"].includes(parsed.type)) return null;
  const info = parsed.info ?? {};
  let amount = info.amount;
  if (info.tokenAmount && typeof info.tokenAmount === "object") amount = info.tokenAmount.amount;
  if (amount == null || !info.source || !info.destination) return null;
  return {
    source: String(info.source), destination: String(info.destination), amount: BigInt(amount),
    mint: info.mint ?? null, authority: info.authority ?? null,
  };
}

function userTargetFlows(instructions, targetMint, trader, accounts) {
  const flows = { buy: 0n, sell: 0n };
  for (const instruction of instructions) {
    const transfer = parsedTransfer(instruction);
    if (!transfer) continue;
    const source = accounts.get(transfer.source);
    const destination = accounts.get(transfer.destination);
    const mint = transfer.mint ?? source?.mint ?? destination?.mint;
    if (mint !== targetMint) continue;
    if (destination?.owner === trader && source?.owner !== trader) flows.buy += transfer.amount;
    else if (source?.owner === trader && destination?.owner !== trader) flows.sell += transfer.amount;
  }
  return flows;
}

function userSolFlows(instructions, trader, accounts) {
  const flows = { incoming: 0n, outgoing: 0n };
  for (const instruction of instructions) {
    const transfer = parsedTransfer(instruction);
    if (transfer) {
      const source = accounts.get(transfer.source);
      const destination = accounts.get(transfer.destination);
      const mint = transfer.mint ?? source?.mint ?? destination?.mint;
      if (mint === WSOL_MINT) {
        if (destination?.owner === trader && source?.owner !== trader) flows.incoming += transfer.amount;
        else if (source?.owner === trader && destination?.owner !== trader) flows.outgoing += transfer.amount;
      }
      continue;
    }
    const parsed = instruction.parsed ?? {};
    const info = parsed.info ?? {};
    if (parsed.type === "transfer" && instruction.program === "system") {
      const lamports = BigInt(info.lamports ?? 0);
      if (String(info.destination) === trader) flows.incoming += lamports;
      else if (String(info.source) === trader) flows.outgoing += lamports;
    }
  }
  return flows;
}

function solSummary(meta, keys, trader, feePayer) {
  const index = keys.indexOf(trader);
  const pre = index >= 0 ? BigInt(meta.preBalances?.[index] ?? 0) : 0n;
  const post = index >= 0 ? BigInt(meta.postBalances?.[index] ?? 0) : 0n;
  const fee = trader === feePayer ? BigInt(meta.fee ?? 0) : 0n;
  return { before: formatRaw(pre, 9), after: formatRaw(post, 9), delta: formatSigned(post - pre, 9), fee: formatRaw(fee, 9) };
}

function decimalsFor(accounts) {
  return accounts.values().next().value?.decimals ?? 0;
}

export function formatRaw(raw, decimals, places = 9) {
  raw = BigInt(raw);
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const digits = value.toString().padStart(decimals + 1, "0");
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).slice(0, places).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole || "0"}${fraction ? `.${fraction}` : ""}`;
}

function formatSigned(raw, decimals) {
  if (raw === 0n) return "0";
  return `${raw > 0n ? "+" : "-"}${formatRaw(absBigInt(raw), decimals)}`;
}

function absBigInt(value) {
  return value < 0n ? -value : value;
}

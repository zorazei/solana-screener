import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTransaction } from "../public/analyzer.js";

const USER = "User111111111111111111111111111111111111111";
const USER_TOKEN = "UserToken1111111111111111111111111111111111";
const POOL_TOKEN = "PoolToken1111111111111111111111111111111111";
const USER_WSOL = "UserWsol11111111111111111111111111111111111";
const POOL_WSOL = "PoolWsol11111111111111111111111111111111111";
const POOL_OWNER = "PoolOwner111111111111111111111111111111111";
const MINT = "Mint111111111111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
const RAYDIUM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

function balance(accountIndex, mint, owner, amount, decimals) {
  return { accountIndex, mint, owner, uiTokenAmount: { amount: String(amount), decimals } };
}

function transfer(source, destination, amount, mint) {
  return {
    program: "spl-token",
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    parsed: { type: "transferChecked", info: { source, destination, mint, tokenAmount: { amount: String(amount), decimals: mint === MINT ? 6 : 9 } } },
  };
}

function transaction(groups, targetPre, targetPost, error = null) {
  const keys = [USER, USER_TOKEN, POOL_TOKEN, USER_WSOL, POOL_WSOL];
  return {
    slot: 123456,
    transaction: { message: {
      accountKeys: keys.map((pubkey, index) => ({ pubkey, signer: index === 0, writable: true })),
      instructions: groups.map(() => ({ programId: RAYDIUM })),
    } },
    meta: {
      err: error,
      fee: 5000,
      preBalances: [2_000_000_000, 0, 0, 0, 0],
      postBalances: [1_499_995_000, 0, 0, 0, 0],
      preTokenBalances: [
        balance(1, MINT, USER, targetPre, 6), balance(2, MINT, POOL_OWNER, 5_000_000_000, 6),
        balance(3, WSOL, USER, 1_000_000_000, 9), balance(4, WSOL, POOL_OWNER, 10_000_000_000, 9),
      ],
      postTokenBalances: [
        balance(1, MINT, USER, targetPost, 6), balance(2, MINT, POOL_OWNER, 5_000_000_000 - (targetPost - targetPre), 6),
        balance(3, WSOL, USER, 500_000_000, 9), balance(4, WSOL, POOL_OWNER, 10_500_000_000, 9),
      ],
      innerInstructions: groups.map((instructions, index) => ({ index, instructions })),
    },
  };
}

test("точная BUY с WSOL", () => {
  const tx = transaction([[transfer(POOL_TOKEN, USER_TOKEN, 100_000_000, MINT), transfer(USER_WSOL, POOL_WSOL, 500_000_000, WSOL)]], 0, 100_000_000);
  const result = analyzeTransaction(tx, MINT);
  assert.equal(result.length, 1);
  assert.equal(result[0].direction, "BUY");
  assert.equal(result[0].amount, "100");
  assert.equal(result[0].swapSol, "0.5");
  assert.equal(result[0].solBefore, "2");
  assert.equal(result[0].solAfter, "1.499995");
  assert.equal(result[0].solDelta, "-0.500005");
});

test("сложная BUY+SELL дает две строки", () => {
  const tx = transaction([[transfer(POOL_TOKEN, USER_TOKEN, 100_000_000, MINT)], [transfer(USER_TOKEN, POOL_TOKEN, 40_000_000, MINT)]], 0, 60_000_000);
  const result = analyzeTransaction(tx, MINT);
  assert.deepEqual(result.map((item) => item.direction), ["BUY", "SELL"]);
  assert.deepEqual(result.map((item) => item.amount), ["100", "40"]);
});

test("неуспешный DEX-вызов дает FAILED SWAP с нулем", () => {
  const tx = transaction([[]], 0, 0, { InstructionError: [0, "Custom"] });
  const result = analyzeTransaction(tx, MINT);
  assert.equal(result.length, 1);
  assert.equal(result[0].direction, "FAILED SWAP");
  assert.equal(result[0].amount, "0");
  assert.equal(result[0].swapSol, "0");
});

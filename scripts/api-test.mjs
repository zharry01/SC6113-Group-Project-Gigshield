// REST API integration test. Run against a backend that indexes a seeded local deployment:
//   API_URL=http://localhost:4000 node scripts/api-test.mjs
import { ethers } from "ethers";

const API = process.env.API_URL || "http://localhost:4000";
const results = [];

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function check(id, name, fn) {
  try {
    const detail = await fn();
    results.push({ id, name, result: "PASS", detail: detail ?? "" });
  } catch (e) {
    results.push({ id, name, result: "FAIL", detail: e.message });
  }
}

function expect(cond, msg) { if (!cond) throw new Error(msg); }

await check("API-01", "GET /api/health returns ok", async () => {
  const r = await call("GET", "/api/health");
  expect(r.status === 200 && r.body.ok === true, `status ${r.status}`);
  return "200 ok=true";
});

await check("API-02", "GET /api/config exposes the 4 contract addresses", async () => {
  const r = await call("GET", "/api/config");
  const a = r.body.addresses;
  expect(r.status === 200 && a && a.shield && a.registry && a.token && a.pool, "addresses missing");
  return `chainId ${r.body.chainId}`;
});

await check("API-03", "GET /api/stats aggregates KPIs and chart series", async () => {
  const r = await call("GET", "/api/stats");
  expect(r.status === 200 && r.body.totals && r.body.claims && Array.isArray(r.body.gas), "shape");
  return `policies=${r.body.totals.policies}, claims filed=${r.body.claims.filed}, events=${r.body.totals.events}`;
});

await check("API-04", "GET /api/events paginates and filters by name", async () => {
  const r = await call("GET", "/api/events?name=ClaimFiled&limit=2");
  expect(r.status === 200 && r.body.items.length <= 2, "limit not applied");
  expect(r.body.items.every((e) => e.name === "ClaimFiled"), "filter not applied");
  return `total=${r.body.total}, returned=${r.body.items.length}`;
});

await check("API-05", "GET /api/events rejects invalid pagination (400)", async () => {
  const r = await call("GET", "/api/events?limit=abc");
  expect(r.status === 400 && r.body.error, `status ${r.status}`);
  return r.body.error;
});

await check("API-06", "GET /api/events rejects invalid actor address (400)", async () => {
  const r = await call("GET", "/api/events?actor=0x123");
  expect(r.status === 400, `status ${r.status}`);
  return r.body.error;
});

await check("API-07", "POST /api/evidence rejects too-short text (400)", async () => {
  const r = await call("POST", "/api/evidence", { text: "short", submitter: ethers.ZeroAddress });
  expect(r.status === 400, `status ${r.status}`);
  return r.body.error;
});

await check("API-08", "POST /api/evidence rejects invalid submitter (400)", async () => {
  const r = await call("POST", "/api/evidence", { text: "valid evidence text here", submitter: "alice" });
  expect(r.status === 400, `status ${r.status}`);
  return r.body.error;
});

const text = `API test evidence ${Date.now()}: clinic receipt #T-1`;
await check("API-09", "POST /api/evidence stores text and returns keccak256", async () => {
  const r = await call("POST", "/api/evidence", { text, submitter: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
  expect(r.status === 201 && r.body.hash === ethers.id(text), "hash mismatch");
  return r.body.hash.slice(0, 18) + "…";
});

await check("API-10", "GET /api/evidence/:hash returns text with verified=true", async () => {
  const r = await call("GET", `/api/evidence/${ethers.id(text)}`);
  expect(r.status === 200 && r.body.verified === true && r.body.text === text, "not verified");
  return "verified=true";
});

await check("API-11", "GET /api/evidence/:hash unknown hash (404)", async () => {
  const r = await call("GET", `/api/evidence/${ethers.id("does-not-exist")}`);
  expect(r.status === 404, `status ${r.status}`);
  return r.body.error;
});

await check("API-12", "POST /api/transactions rejects malformed hash (400)", async () => {
  const r = await call("POST", "/api/transactions", { hash: "0xabc", action: "Faucet", from: ethers.ZeroAddress });
  expect(r.status === 400, `status ${r.status}`);
  return r.body.error;
});

await check("API-13", "POST /api/transactions rejects spoofed sender (400)", async () => {
  const ev = await call("GET", "/api/events?name=ClaimFiled&limit=1");
  const hash = ev.body.items[0].tx_hash;
  const r = await call("POST", "/api/transactions", { hash, action: "File claim", from: "0x0000000000000000000000000000000000000001" });
  expect(r.status === 400, `status ${r.status}`);
  return r.body.error;
});

await check("API-14", "POST /api/config rejects expired signature (400)", async () => {
  const cfg = await call("GET", "/api/config");
  const r = await call("POST", "/api/config", { address: cfg.body.contractAddress, timestamp: 1, signature: "0x00" });
  expect(r.status === 400, `status ${r.status}`);
  return r.body.error;
});

await check("API-15", "POST /api/config rejects non-Admin signer (403)", async () => {
  const cfg = await call("GET", "/api/config");
  const w = ethers.Wallet.createRandom();
  const timestamp = Date.now();
  const signature = await w.signMessage(`GigShield: register contract ${cfg.body.contractAddress} at ${timestamp}`);
  const r = await call("POST", "/api/config", { address: cfg.body.contractAddress, timestamp, signature });
  expect(r.status === 403, `status ${r.status}`);
  return r.body.error;
});

await check("API-16", "Malformed JSON body is handled (400)", async () => {
  const r = await call("POST", "/api/evidence", "{not json");
  expect(r.status === 400, `status ${r.status}`);
  return r.body?.error;
});

await check("API-17", "Unknown API route (404 JSON)", async () => {
  const r = await call("GET", "/api/unknown");
  expect(r.status === 404 && r.body.error, `status ${r.status}`);
  return r.body.error;
});

console.log("| ID | Test | Result | Detail |\n|---|---|---|---|");
for (const r of results) console.log(`| ${r.id} | ${r.name} | ${r.result === "PASS" ? "✅ PASS" : "❌ FAIL"} | ${String(r.detail).replace(/\|/g, "/")} |`);
const failed = results.filter((r) => r.result === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

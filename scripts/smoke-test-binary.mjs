#!/usr/bin/env node
/**
 * Cross-OS smoke test for a vaultpilot-mcp release binary.
 *
 * Spawns the binary, sends a `tools/list` JSON-RPC request on stdin,
 * waits up to TIMEOUT_MS for a response that contains a non-empty
 * `result.tools[]`, then kills the process and exits 0. Any failure
 * (timeout, crash, missing tools field) exits 1.
 *
 * Replaces the previous per-OS shell snippets in
 * `.github/workflows/release-binaries.yml`. Linux had GNU `timeout`
 * available; macOS does not by default (would need
 * `brew install coreutils`); Windows used a separate pwsh path. One
 * Node script runs identically on all three.
 *
 * Usage:
 *   node scripts/smoke-test-binary.mjs <path-to-binary>
 */
import { spawn } from "node:child_process";
import process from "node:process";

const binary = process.argv[2];
if (!binary) {
  console.error("usage: node scripts/smoke-test-binary.mjs <binary-path>");
  process.exit(2);
}

const TIMEOUT_MS = 20_000;
const REQUEST = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n';

const proc = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
let done = false;

const timer = setTimeout(() => {
  if (done) return;
  console.error(`smoke test timed out after ${TIMEOUT_MS}ms`);
  proc.kill();
  process.exit(1);
}, TIMEOUT_MS);

proc.stdout.on("data", (chunk) => {
  if (done) return;
  buf += chunk.toString("utf8");
  // The binary may print warnings on stderr (handled below) and a JSON
  // envelope on stdout. Walk completed lines until we find one parseable
  // as a JSON-RPC result with a non-empty tools array.
  const lines = buf.split("\n");
  buf = lines.pop() ?? ""; // keep partial last line in buffer
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const j = JSON.parse(trimmed);
      if (Array.isArray(j.result?.tools) && j.result.tools.length > 0) {
        console.log(`tools: ${j.result.tools.length}`);
        done = true;
        clearTimeout(timer);
        proc.kill();
        process.exit(0);
      }
    } catch {
      // Partial line or non-JSON; keep reading.
    }
  }
});

// Forward stderr so CI logs show any startup diagnostics from the binary.
proc.stderr.on("data", (chunk) => process.stderr.write(chunk));

proc.on("exit", (code, signal) => {
  if (done) return;
  console.error(
    `binary exited before tools/list response (code=${code} signal=${signal})`,
  );
  clearTimeout(timer);
  process.exit(1);
});

proc.on("error", (err) => {
  console.error("failed to spawn binary:", err.message);
  clearTimeout(timer);
  process.exit(1);
});

// Drive the request.
proc.stdin.write(REQUEST);

#!/usr/bin/env node
/**
 * Interactive setup for VaultPilot MCP.
 *
 *   - Picks an RPC provider (Infura / Alchemy / custom) and validates the API key
 *     against a live eth_chainId call.
 *   - Optionally captures an Etherscan API key (improves contract-verification tools).
 *   - Optionally captures a WalletConnect Cloud project ID.
 *   - Optionally pairs Ledger Live over WalletConnect right now.
 *   - Persists everything to ~/.vaultpilot-mcp/config.json (0600) and prints a
 *     Claude Desktop config snippet the user can copy.
 *
 * Env vars always override the config file at runtime — the setup flow is for
 * users who'd rather not manage env vars.
 */
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import qrcodeTerminal from "qrcode-terminal";
import {
  patchUserConfig,
  readUserConfig,
  getConfigPath,
} from "./config/user-config.js";
import type { RpcProvider, SupportedChain, UserConfig } from "./types/index.js";

/** Thin readline wrapper so each prompt is a single awaited call. */
class Prompt {
  private rl: ReadlineInterface;
  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
  }
  ask(question: string): Promise<string> {
    return new Promise((resolve) => this.rl.question(question, (a) => resolve(a.trim())));
  }
  async askDefault(question: string, def: string): Promise<string> {
    const answer = await this.ask(`${question} [${def}]: `);
    return answer === "" ? def : answer;
  }
  async askYesNo(question: string, def: boolean): Promise<boolean> {
    const hint = def ? "Y/n" : "y/N";
    const answer = (await this.ask(`${question} (${hint}): `)).toLowerCase();
    if (answer === "") return def;
    return answer === "y" || answer === "yes";
  }
  async askChoice(question: string, choices: string[], def: number): Promise<number> {
    console.log(question);
    choices.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
    const raw = await this.ask(`Choose [${def + 1}]: `);
    if (raw === "") return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > choices.length) {
      console.log(`  Invalid selection — defaulting to ${choices[def]}.`);
      return def;
    }
    return n - 1;
  }
  close() {
    this.rl.close();
  }
}

const PROVIDER_URLS: Record<"infura" | "alchemy", Record<SupportedChain, (k: string) => string>> = {
  infura: {
    ethereum: (k) => `https://mainnet.infura.io/v3/${k}`,
    arbitrum: (k) => `https://arbitrum-mainnet.infura.io/v3/${k}`,
    polygon: (k) => `https://polygon-mainnet.infura.io/v3/${k}`,
    base: (k) => `https://base-mainnet.infura.io/v3/${k}`,
  },
  alchemy: {
    ethereum: (k) => `https://eth-mainnet.g.alchemy.com/v2/${k}`,
    arbitrum: (k) => `https://arb-mainnet.g.alchemy.com/v2/${k}`,
    polygon: (k) => `https://polygon-mainnet.g.alchemy.com/v2/${k}`,
    base: (k) => `https://base-mainnet.g.alchemy.com/v2/${k}`,
  },
};

/** Make a minimal eth_chainId call against the URL. Returns the numeric chain ID on success. */
async function validateRpcUrl(url: string): Promise<number> {
  const client = createPublicClient({ chain: mainnet, transport: http(url, { retryCount: 0 }) });
  const id = await client.getChainId();
  return id;
}

async function configureRpc(p: Prompt): Promise<UserConfig["rpc"]> {
  console.log("\n--- RPC Provider ---");
  const providerIdx = await p.askChoice(
    "Select an RPC provider:",
    ["Infura", "Alchemy", "Custom (bring your own URLs)"],
    0
  );
  const provider = (["infura", "alchemy", "custom"] as RpcProvider[])[providerIdx];

  if (provider === "custom") {
    const ethUrl = await p.ask("Ethereum RPC URL: ");
    const arbUrl = await p.ask("Arbitrum RPC URL (leave blank to skip): ");
    const polyUrl = await p.ask("Polygon RPC URL (leave blank to skip): ");
    const baseUrl = await p.ask("Base RPC URL (leave blank to skip): ");
    if (ethUrl) {
      try {
        const id = await validateRpcUrl(ethUrl);
        if (id !== 1) console.warn(`  Warning: Ethereum URL returned chain ID ${id}, expected 1.`);
        else console.log("  Ethereum URL OK.");
      } catch (e) {
        console.warn(`  Warning: could not validate Ethereum URL — ${(e as Error).message}`);
      }
    }
    return {
      provider: "custom",
      customUrls: {
        ...(ethUrl ? { ethereum: ethUrl } : {}),
        ...(arbUrl ? { arbitrum: arbUrl } : {}),
        ...(polyUrl ? { polygon: polyUrl } : {}),
        ...(baseUrl ? { base: baseUrl } : {}),
      },
    };
  }

  // infura / alchemy
  const existing = readUserConfig();
  const prevKey = existing?.rpc.provider === provider ? existing.rpc.apiKey : undefined;
  let apiKey = prevKey ?? "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt = prevKey
      ? `${provider} API key [press enter to keep existing]: `
      : `${provider} API key: `;
    const entered = await p.ask(prompt);
    apiKey = entered || prevKey || "";
    if (!apiKey) {
      console.log("  An API key is required.");
      continue;
    }
    const testUrl = PROVIDER_URLS[provider].ethereum(apiKey);
    try {
      const id = await validateRpcUrl(testUrl);
      if (id === 1) {
        console.log(`  ${provider} API key OK — Ethereum chain ID ${id}.`);
        return { provider, apiKey };
      }
      console.warn(`  Unexpected chain ID ${id} from ${provider}.`);
    } catch (e) {
      console.warn(`  Validation failed: ${(e as Error).message}`);
    }
  }
  throw new Error(`Could not validate ${provider} API key after 3 attempts.`);
}

async function configureEtherscan(p: Prompt): Promise<string | undefined> {
  console.log("\n--- Etherscan (optional) ---");
  console.log("Improves contract-verification tools. Skip with empty input.");
  const existing = readUserConfig()?.etherscanApiKey;
  const answer = await p.ask(
    existing
      ? "Etherscan API key [press enter to keep existing]: "
      : "Etherscan API key (or blank to skip): "
  );
  if (!answer && existing) return existing;
  return answer || undefined;
}

async function configureOneInch(p: Prompt): Promise<string | undefined> {
  console.log("\n--- 1inch (optional — enables swap-quote comparison vs LiFi) ---");
  console.log("Create a free key at https://portal.1inch.dev. Skip with empty input.");
  const existing = readUserConfig()?.oneInchApiKey;
  const answer = await p.ask(
    existing
      ? "1inch API key [press enter to keep existing]: "
      : "1inch API key (or blank to skip): "
  );
  if (!answer && existing) return existing;
  return answer || undefined;
}

async function validateTronApiKey(apiKey: string): Promise<void> {
  // USDT-TRC20 address — well-known, always returns 200 on a healthy grid.
  const url = "https://api.trongrid.io/v1/accounts/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const res = await fetch(url, { headers: { "TRON-PRO-API-KEY": apiKey } });
  if (!res.ok) {
    throw new Error(`TronGrid returned ${res.status} ${res.statusText}`);
  }
}

async function configureTron(p: Prompt): Promise<string | undefined> {
  console.log("\n--- TRON (optional — enables TRX + TRC-20 balance reads) ---");
  console.log("TRON is non-EVM: no Aave/Compound/Uniswap there, but TRC-20 USDT");
  console.log("dominates the chain and is worth folding into your portfolio total.");
  console.log("Create a free key at https://www.trongrid.io (Dashboard → API Keys).");
  console.log("Skip with empty input — TRON reads will be disabled.");
  const existing = readUserConfig()?.tronApiKey;
  const answer = await p.ask(
    existing
      ? "TronGrid API key [press enter to keep existing]: "
      : "TronGrid API key (or blank to skip): "
  );
  const apiKey = answer || existing;
  if (!apiKey) return undefined;

  try {
    await validateTronApiKey(apiKey);
    console.log("  TronGrid API key OK.");
  } catch (e) {
    console.warn(`  Warning: could not validate TronGrid key — ${(e as Error).message}`);
    console.warn("  Saving anyway; TRON reads will surface the error at query time.");
  }
  return apiKey;
}

async function configureWalletConnect(p: Prompt): Promise<string | undefined> {
  console.log("\n--- WalletConnect (optional — required for Ledger Live signing) ---");
  console.log("Create a free project at https://cloud.walletconnect.com.");
  const existing = readUserConfig()?.walletConnect?.projectId;
  const answer = await p.ask(
    existing
      ? "WalletConnect project ID [press enter to keep existing]: "
      : "WalletConnect project ID (or blank to skip): "
  );
  if (!answer && existing) return existing;
  return answer || undefined;
}

async function pairLedgerLiveFlow(p: Prompt): Promise<void> {
  console.log("\n--- Ledger Live pairing ---");
  const proceed = await p.askYesNo("Pair Ledger Live now via WalletConnect?", false);
  if (!proceed) return;

  // Dynamically import so the setup still runs cleanly when WC fails to initialize.
  const { initiatePairing } = await import("./signing/walletconnect.js");
  let pairing: { uri: string; approval: Promise<unknown> };
  try {
    pairing = await initiatePairing();
  } catch (e) {
    console.error(`  Could not initiate pairing: ${(e as Error).message}`);
    return;
  }

  console.log("\nScan this QR in Ledger Live → Discover → WalletConnect, or paste the URI:\n");
  await new Promise<void>((resolve) =>
    qrcodeTerminal.generate(pairing.uri, { small: true }, (qr: string) => {
      console.log(qr);
      resolve();
    })
  );
  // The URI carries the WalletConnect topic + a one-shot symmetric key. It
  // isn't long-lived key material, but anyone who pairs with it first wins
  // the session, so keep it out of long-lived logs and terminal scrollback
  // shared with others.
  console.log(`URI (sensitive — don't share; one-time pairing secret): ${pairing.uri}\n`);
  console.log("Waiting for you to approve the session in Ledger Live (Ctrl-C to cancel)...");

  try {
    await pairing.approval;
    console.log("Paired. Session persisted to config.");
  } catch (e) {
    console.error(`Pairing failed: ${(e as Error).message}`);
  }
}

function printClaudeDesktopSnippet(): void {
  const binPath = "vaultpilot-mcp"; // installed via `npm i -g vaultpilot-mcp`
  const snippet = {
    mcpServers: {
      "vaultpilot-mcp": {
        command: binPath,
      },
    },
  };
  console.log("\n--- Claude Desktop config snippet ---");
  console.log("Add the following to `claude_desktop_config.json`:\n");
  console.log(JSON.stringify(snippet, null, 2));
  console.log(
    "\nIf you're running from source rather than a global install, use:\n" +
      JSON.stringify(
        {
          mcpServers: {
            "vaultpilot-mcp": {
              command: "node",
              args: [`${process.cwd()}/dist/index.js`],
            },
          },
        },
        null,
        2
      )
  );
}

async function main() {
  console.log("VaultPilot MCP — interactive setup\n");
  console.log(`Config path: ${getConfigPath()}`);

  const p = new Prompt();
  try {
    const rpc = await configureRpc(p);
    patchUserConfig({ rpc });

    const etherscanApiKey = await configureEtherscan(p);
    if (etherscanApiKey !== undefined) {
      patchUserConfig({ etherscanApiKey });
    }

    const oneInchApiKey = await configureOneInch(p);
    if (oneInchApiKey !== undefined) {
      patchUserConfig({ oneInchApiKey });
    }

    const tronApiKey = await configureTron(p);
    if (tronApiKey !== undefined) {
      patchUserConfig({ tronApiKey });
    }

    const wcProjectId = await configureWalletConnect(p);
    if (wcProjectId !== undefined) {
      patchUserConfig({ walletConnect: { projectId: wcProjectId } });
    }

    // Pairing needs the project ID to be in config already (getSignClient reads it).
    if (wcProjectId) {
      await pairLedgerLiveFlow(p);
    } else {
      console.log("\nSkipping Ledger Live pairing (no WalletConnect project ID set).");
    }

    console.log(`\nConfig written to ${getConfigPath()}.`);
    printClaudeDesktopSnippet();
  } catch (err) {
    console.error(`\nSetup aborted: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    p.close();
  }
}

main().then(() => {
  // WalletConnect's SignClient keeps websocket/relay handles open that prevent
  // a natural event-loop exit. Force-exit so the CLI returns control to the
  // shell; process.exitCode (set on error) is honored.
  process.exit();
});

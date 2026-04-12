import { getConnectedAccounts, getCurrentSession, getSignClient } from "./walletconnect.js";

export interface SessionStatus {
  paired: boolean;
  accounts: `0x${string}`[];
  topic?: string;
  expiresAt?: number;
  wallet?: string;
}

export async function getSessionStatus(): Promise<SessionStatus> {
  await getSignClient(); // triggers restore
  const session = getCurrentSession();
  if (!session) return { paired: false, accounts: [] };
  const accounts = await getConnectedAccounts();
  const peer = session.peer?.metadata?.name;
  return {
    paired: true,
    accounts,
    topic: session.topic,
    expiresAt: session.expiry * 1000,
    wallet: peer,
  };
}

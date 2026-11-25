// rola-client.ts — the browser's half of a Radix wallet sign-in: the toolkit,
// loaded on first use so a reader who never connects downloads none of it,
// asked for an account with a proof of the server's challenge.
//
// radix-wiki and caper had each wired the toolkit by hand, the same five steps
// in the same order: build it, hand it the challenge, ask for accounts with a
// proof, and read the first account's proof out of a fresh answer without ever
// throwing back into the toolkit, whose request would then never settle. What a
// site does with the proof, and how it mirrors the wallet's state, stays its.
// `@radixdlt/radix-dapp-toolkit` is an optional peer, needed only here.

import type { SignedChallenge } from './rola.js';

export type RadixToolkit = ReturnType<typeof import('@radixdlt/radix-dapp-toolkit').RadixDappToolkit>;
/** A fresh answer from the wallet: its accounts, persona and proofs. */
export type WalletResponse = Parameters<Parameters<RadixToolkit['walletApi']['dataRequestControl']>[0]>[0];

export interface RadixWalletOptions {
  dAppDefinitionAddress: string;
  networkId: number;
  applicationName: string;
  applicationVersion?: string;
  /** The server's challenge: a fetch of the challenge route, or a server action. A throw ends the connect attempt. */
  challenge: () => Promise<string>;
  /** A sign-in asks for exactly one account, or for one or more. */
  accounts?: 'one' | 'some';
  /**
   * A fresh answer's first account, proved: the site signs in with it. Called
   * only on an answer to a request, never on the toolkit's replay of a cached
   * wallet at load.
   */
  onProof: (proof: SignedChallenge, response: WalletResponse) => Promise<void>;
  /** What `onProof` threw, which the toolkit never sees, so its request still settles. */
  onError: (error: unknown) => void;
}

/** Loads the toolkit, hands it the challenge and the request, and returns it to subscribe to and send with. */
export async function loadRadixWallet({
  dAppDefinitionAddress,
  networkId,
  applicationName,
  applicationVersion = '1.0.0',
  challenge,
  accounts = 'one',
  onProof,
  onError,
}: RadixWalletOptions): Promise<RadixToolkit> {
  const { RadixDappToolkit, DataRequestBuilder } = await import('@radixdlt/radix-dapp-toolkit');
  const rdt = RadixDappToolkit({ dAppDefinitionAddress, networkId, applicationName, applicationVersion });
  rdt.walletApi.provideChallengeGenerator(challenge);
  const request = DataRequestBuilder.accounts();
  rdt.walletApi.setRequestData((accounts === 'some' ? request.atLeast(1) : request.exactly(1)).withProof());
  rdt.walletApi.dataRequestControl(async response => {
    const account = response.accounts?.[0];
    const proof = response.proofs?.find(p => p.address === account?.address);
    if (!account || !proof) return;
    try {
      await onProof({ challenge: proof.challenge, address: proof.address, proof: proof.proof }, response);
    } catch (error) {
      onError(error);
    }
  });
  return rdt;
}

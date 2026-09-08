/**
 * SRP module for the SDK and the password login flow.
 * Port of the account module's `srp.ts`; the arithmetic lives in @protontech/crypto.
 */
import type { ProtonDriveClientContructorParameters } from '@protontech/drive-sdk';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';

import type { AccountApi } from './accountApi.js';

export type SRPModule = ProtonDriveClientContructorParameters['srpModule'];
export type SRPVerifier = Awaited<ReturnType<SRPModule['getSrpVerifier']>>;

export interface SrpProofs {
  expectedServerProof: string;
  clientProof: string;
  clientEphemeral: string;
}

/** The subset of SRP primitives the login flow needs; injectable for tests. */
export interface SrpPrimitives {
  getSrp(info: { Version: number; Modulus: string; ServerEphemeral: string; Salt: string }, password: string): Promise<SrpProofs>;
  computeKeyPassword(password: string, salt: string): Promise<string>;
}

export const realSrpPrimitives: SrpPrimitives = {
  async getSrp(info, password) {
    const result = await getSrp(info, { password });
    return {
      expectedServerProof: String(result.expectedServerProof),
      clientProof: String(result.clientProof),
      clientEphemeral: String(result.clientEphemeral),
    };
  },
  computeKeyPassword: (password, salt) => computeKeyPassword(password, salt),
};

export class Srp implements SRPModule {
  constructor(
    private readonly accountApi: AccountApi,
    private readonly primitives: SrpPrimitives = realSrpPrimitives,
  ) {}

  getSrp(version: number, modulus: string, serverEphemeral: string, salt: string, password: string): Promise<SrpProofs> {
    return this.primitives.getSrp({ Version: version, Modulus: modulus, ServerEphemeral: serverEphemeral, Salt: salt }, password);
  }

  async getSrpVerifier(password: string): Promise<SRPVerifier> {
    const result = await this.accountApi.modulus();
    if (result.Modulus === undefined || result.ModulusID === undefined) throw new Error('Missing modulus');
    const generated: unknown = await getRandomSrpVerifier({ Modulus: result.Modulus }, { password });
    const g = generated as { version: number; salt: string; verifier: string };
    return { modulusId: result.ModulusID, version: g.version, salt: g.salt, verifier: g.verifier };
  }

  computeKeyPassword(password: string, salt: string): Promise<string> {
    return this.primitives.computeKeyPassword(password, salt);
  }

  generateKeySalt(): string {
    return String(generateKeySalt());
  }
}

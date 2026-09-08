/**
 * Own addresses and keys, unlocked with the user key password, plus public
 * keys of other users. Port of the account module's `addresses.ts`.
 *
 * Implements the SDK's ProtonDriveAccount interface directly.
 */
import type { ProtonDriveAccount, ProtonDriveAccountAddress } from '@protontech/drive-sdk';
import { VERIFICATION_STATUS, type PrivateKeyReference, type PublicKeyReference } from '@protontech/crypto';

import type { AccountApi} from './accountApi.js';
import { AddressNotFoundError, type Address, type AddressKey } from './accountApi.js';
import type { Logger } from './logger.js';
import type { SessionCredentials } from './sessionCredentials.js';

/** The key operations this module needs; the real implementation is CryptoProxy. */
export interface KeyCrypto {
  importPrivateKey(options: { armoredKey: string; passphrase: string }): Promise<PrivateKeyReference>;
  importPublicKey(options: { armoredKey: string } | { binaryKey: Uint8Array<ArrayBuffer> }): Promise<PublicKeyReference>;
  exportPublicKey(options: { key: PrivateKeyReference | PublicKeyReference; format: 'binary' }): Promise<Uint8Array<ArrayBuffer>>;
  decryptMessage(options: {
    armoredMessage: string;
    armoredSignature: string;
    decryptionKeys: PrivateKeyReference[];
    verificationKeys: PublicKeyReference[];
  }): Promise<{ data: string; verificationStatus: number }>;
}

/**
 * VERIFICATION_STATUS.SIGNED_AND_VALID in @protontech/crypto (NOT_SIGNED = 0,
 * SIGNED_AND_VALID = 1, SIGNED_AND_INVALID = 2). Was wrongly 2, which made every
 * address key token fail verification against the live API.
 */
export const SIGNED_AND_VALID: number = VERIFICATION_STATUS.SIGNED_AND_VALID;

interface UserData {
  userPrivateKeys: PrivateKeyReference[];
  userPublicKeys: PublicKeyReference[];
  primaryAddressId: string;
  addresses: Address[];
}

interface AddressKeyPair {
  id: string;
  privateKey: PrivateKeyReference;
  publicKey: PublicKeyReference;
}

export class Addresses implements ProtonDriveAccount {
  private userData: Promise<UserData> | undefined;
  private readonly otherPublicKeys = new Map<string, Promise<PublicKeyReference[]>>();
  private readonly addressKeys = new Map<string, Promise<AddressKeyPair>>();

  constructor(
    private readonly accountApi: AccountApi,
    private readonly credentials: SessionCredentials,
    private readonly crypto: KeyCrypto,
    private readonly logger: Logger,
  ) {
    credentials.on('sessionInfoChanged', () => {
      this.userData = undefined;
      this.otherPublicKeys.clear();
      this.addressKeys.clear();
    });
  }

  async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
    const { primaryAddressId } = await this.getUserData();
    return this.getOwnAddress(primaryAddressId);
  }

  async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
    const data = await this.getUserData();
    const out: ProtonDriveAccountAddress[] = [];
    for (const address of data.addresses) out.push(await this.getOwnAddress(address.ID));
    if (out.length === 0) throw new Error('No addresses');
    return out;
  }

  async getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
    const data = await this.getUserData();
    const address = data.addresses.find((a) => a.ID === emailOrAddressId || a.Email === emailOrAddressId);
    if (address === undefined) throw new Error(`Address ${emailOrAddressId} not found`);
    const keys: { id: string; key: PrivateKeyReference }[] = [];
    const errors: unknown[] = [];
    for (const key of address.Keys ?? []) {
      try {
        const pair = await this.getAddressKey(data, key, address.Email);
        keys.push({ id: pair.id, key: pair.privateKey });
      } catch (error) {
        this.logger.error(`Could not load address key ${key.ID} for ${address.Email}`, error);
        errors.push(error);
      }
    }
    if (keys.length === 0) {
      const reasons = errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
      throw new Error(`No usable private key for address ${address.Email}: ${reasons}`, { cause: errors });
    }
    return { email: address.Email, addressId: address.ID, primaryKeyIndex: 0, keys };
  }

  async hasProtonAccount(email: string): Promise<boolean> {
    return (await this.getPublicKeys(email)).length > 0;
  }

  async getPublicKeys(email: string, forceRefresh?: boolean): Promise<PublicKeyReference[]> {
    if (!this.credentials.isLoggedIn()) return [];
    const data = await this.getUserData();
    const own = data.addresses.find((a) => a.Email.toLowerCase() === email.toLowerCase());
    if (own !== undefined) {
      const keys: PublicKeyReference[] = [];
      for (const key of own.Keys ?? []) {
        try {
          keys.push((await this.getAddressKey(data, key, own.Email)).publicKey);
        } catch (error) {
          this.logger.error(`Could not load own public key ${key.ID}`, error);
        }
      }
      return keys;
    }
    return this.getOtherPublicKeys(email, forceRefresh === true);
  }

  private getOtherPublicKeys(email: string, forceRefresh: boolean): Promise<PublicKeyReference[]> {
    const cached = this.otherPublicKeys.get(email);
    if (!forceRefresh && cached !== undefined) return cached;
    const promise = (async () => {
      try {
        const response = await this.accountApi.keys(email);
        return await Promise.all((response.Address?.Keys ?? []).map((k) => this.crypto.importPublicKey({ armoredKey: k.PublicKey })));
      } catch (error) {
        if (error instanceof AddressNotFoundError) return [];
        this.otherPublicKeys.delete(email);
        throw error;
      }
    })();
    this.otherPublicKeys.set(email, promise);
    return promise;
  }

  private getUserData(): Promise<UserData> {
    this.userData ??= (async () => {
      try {
        const userKeyPassword = this.credentials.getUserKeyPassword();
        if (userKeyPassword === undefined) throw new Error('Not logged in: key password is not available');
        const users = await this.accountApi.users();
        const userPrivateKeys: PrivateKeyReference[] = [];
        const userPublicKeys: PublicKeyReference[] = [];
        for (const userKey of users.User?.Keys ?? []) {
          try {
            const privateKey = await this.crypto.importPrivateKey({ armoredKey: userKey.PrivateKey, passphrase: userKeyPassword });
            const publicKey = await this.crypto.importPublicKey({ binaryKey: await this.crypto.exportPublicKey({ key: privateKey, format: 'binary' }) });
            userPrivateKeys.push(privateKey);
            userPublicKeys.push(publicKey);
          } catch (error) {
            this.logger.error(`Could not unlock user key ${userKey.ID}`, error);
          }
        }
        if (userPrivateKeys.length === 0) throw new Error('No user key could be unlocked; the stored key password may be stale');
        const addresses = (await this.accountApi.addresses()).Addresses ?? [];
        const primary = addresses[0];
        if (primary === undefined) throw new Error('Missing primary address');
        return { userPrivateKeys, userPublicKeys, primaryAddressId: primary.ID, addresses };
      } catch (error) {
        this.userData = undefined;
        throw error;
      }
    })();
    return this.userData;
  }

  private getAddressKey(data: UserData, key: AddressKey, email: string): Promise<AddressKeyPair> {
    const cached = this.addressKeys.get(key.ID);
    if (cached !== undefined) return cached;
    const promise = (async (): Promise<AddressKeyPair> => {
      try {
        if (key.PrivateKey === undefined) throw new Error(`Address key ${key.ID} has no private key`);
        let passphrase: string;
        if (key.Token === undefined || key.Token === '') {
          // Legacy key encrypted directly with the key password.
          const userKeyPassword = this.credentials.getUserKeyPassword();
          if (userKeyPassword === undefined) throw new Error('Key password is not available');
          passphrase = userKeyPassword;
        } else {
          const { data: token, verificationStatus } = await this.crypto.decryptMessage({
            armoredMessage: key.Token,
            armoredSignature: key.Signature ?? '',
            decryptionKeys: data.userPrivateKeys,
            verificationKeys: data.userPublicKeys,
          });
          if (verificationStatus !== SIGNED_AND_VALID) throw new Error(`Address key token for ${email} failed signature verification`);
          passphrase = token;
        }
        const privateKey = await this.crypto.importPrivateKey({ armoredKey: key.PrivateKey, passphrase });
        const publicKey = await this.crypto.importPublicKey({ binaryKey: await this.crypto.exportPublicKey({ key: privateKey, format: 'binary' }) });
        return { id: key.ID, privateKey, publicKey };
      } catch (error) {
        this.addressKeys.delete(key.ID);
        throw error;
      }
    })();
    this.addressKeys.set(key.ID, promise);
    return promise;
  }
}

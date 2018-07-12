const ecc = require('enujs-ecc');
const scrypt = require('scrypt-async');
import StorageService from '../services/StorageService';

export default class Hasher {

    /***
     * Hashes a cleartext using the SHA-256 algorithm.
     * This is INSECURE and should only be used for fingerprinting.
     * @param cleartext
     */
    static insecureHash(cleartext) {
        return ecc.sha256(cleartext);
    }

    /***
     * Hashes a cleartext using scrypt.
     * @param cleartext
     */
    static async secureHash(cleartext) {
        return new Promise(async resolve => {
            // We don't need a salt here, because this is a non-saved(!) hash,
            // which is used to create a seed that is used to encrypt
            // the keychain using AES which has it's own salt.
            // const salt = this.insecureHash(cleartext) + this.insecureHash(cleartext).slice(0,16);
            const salt = await StorageService.getSalt();
            scrypt(cleartext, salt, {
                N: 16384,
                r: 8,
                p: 1,
                dkLen: 16,
                encoding: 'hex'
            }, (derivedKey) => {
                resolve(derivedKey);
            })
        });
    }

    /***
     * Checks a cleartext against a insecureHash
     * @param cleartext
     * @param hash
     * @returns {boolean}
     */
    static validate(cleartext, hash) {
        return Hasher.insecureHash(cleartext) === hash
    }
}

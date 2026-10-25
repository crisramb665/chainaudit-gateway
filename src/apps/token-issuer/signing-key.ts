import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type CryptoKey, type JWK } from "jose";

export const SIGNING_ALG = "ES256";

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  /** Public part only, safe to publish in the JWKS. */
  publicJwk: JWK;
}

// LEARN: An asymmetric key splits the power to mint tokens from the power to
// check them. Only this process holds the private key; the gateway and any
// other verifier only download the public key from the JWKS, so a leak on
// their side cannot be used to forge tokens. With HS256 every verifier would
// hold the signing secret. The key is persisted so a restart does not
// invalidate tokens that are still within their 15 minutes.
export async function loadOrCreateSigningKey(path: string): Promise<SigningKey> {
  const existing = await readJwk(path);
  if (existing) {
    const privateKey = await importJWK(existing, SIGNING_ALG);
    // A Uint8Array would mean a symmetric (oct) key, which this issuer never writes.
    if (privateKey instanceof Uint8Array || !existing.kid) throw new Error(`Invalid signing key in ${path}`);
    return { kid: existing.kid, privateKey, publicJwk: publicPart(existing) };
  }

  const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALG, { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  // LEARN: kid is the RFC 7638 thumbprint of the public key, so it is derived
  // from the key itself and stays stable. Verifiers use kid to pick the key
  // from the JWKS, which is what makes rotation possible: publish the new key
  // next to the old one and remove the old one once its tokens have expired.
  const kid = await calculateJwkThumbprint(publicJwk);

  await mkdir(dirname(path), { recursive: true });
  // 0600: the private key is readable by the owner only.
  await writeFile(path, JSON.stringify({ ...(await exportJWK(privateKey)), kid }), { mode: 0o600 });
  return { kid, privateKey, publicJwk };
}

async function readJwk(path: string): Promise<JWK | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as JWK;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

// Copies only the public EC members, so the private scalar `d` can never leak.
function publicPart(jwk: JWK): JWK {
  const { kty, crv, x, y } = jwk;
  return { kty, crv, x, y };
}

/**
 * `cadp-sig-1` root signature profile (TD §9.4 r7): Ed25519 (RFC 8032);
 * key_id = "ed25519:" + sha256(public_key_bytes)[:32 hex];
 * signed bytes = "cadp-v04:sig-1:" || document_kind || 0x00 || cadp-jcs-1(document).
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign as edSign, verify as edVerify } from "node:crypto";

import { jcs, sha256Hex } from "./canonical.ts";

export type RootDocumentKind = "GENESIS" | "BREAK_GLASS";

export interface Sig1 {
  readonly profile: "cadp-sig-1";
  readonly key_id: string;
  readonly sig_base64: string;
}

export function rawPublicKeyBytes(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url");
}

export function keyIdOf(publicKey: KeyObject): string {
  return `ed25519:${sha256Hex(rawPublicKeyBytes(publicKey)).slice(0, 32)}`;
}

export function publicKeyFromBase64(raw_base64: string): KeyObject {
  const x = Buffer.from(raw_base64, "base64").toString("base64url");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

export function generateRootKey(): { privatePem: string; public_key_base64: string; key_id: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    public_key_base64: rawPublicKeyBytes(publicKey).toString("base64"),
    key_id: keyIdOf(publicKey),
  };
}

function signedBytes(kind: RootDocumentKind, document: unknown): Buffer {
  return Buffer.concat([Buffer.from(`cadp-v04:sig-1:${kind}`, "utf8"), Buffer.from([0]), Buffer.from(jcs(document), "utf8")]);
}

export function signDocument(kind: RootDocumentKind, document: unknown, privatePem: string): Sig1 {
  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(privateKey);
  return {
    profile: "cadp-sig-1",
    key_id: keyIdOf(publicKey),
    sig_base64: edSign(null, signedBytes(kind, document), privateKey).toString("base64"),
  };
}

export function verifySignature(kind: RootDocumentKind, document: unknown, sig: Sig1, public_key_base64: string): boolean {
  if (sig.profile !== "cadp-sig-1") return false;
  const publicKey = publicKeyFromBase64(public_key_base64);
  if (keyIdOf(publicKey) !== sig.key_id) return false;
  try {
    return edVerify(null, signedBytes(kind, document), publicKey, Buffer.from(sig.sig_base64, "base64"));
  } catch {
    return false;
  }
}

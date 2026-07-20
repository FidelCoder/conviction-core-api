import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const envelopeVersion = 1;

type CredentialEnvelope = {
  version: number;
  algorithm: "A256GCM";
  iv: string;
  tag: string;
  ciphertext: string;
};

export function encryptJson(value: unknown, keyMaterial: string) {
  const key = parseEncryptionKey(keyMaterial);
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: CredentialEnvelope = {
    version: envelopeVersion,
    algorithm: "A256GCM",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };

  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

export function decryptJson<T>(value: string, keyMaterial: string): T {
  const key = parseEncryptionKey(keyMaterial);
  const envelope = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as CredentialEnvelope;

  if (envelope.version !== envelopeVersion || envelope.algorithm !== "A256GCM") {
    throw new Error("Unsupported credential envelope");
  }

  const decipher = createDecipheriv(algorithm, key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf8")) as T;
}

function parseEncryptionKey(value: string) {
  const trimmed = value.trim();
  const key = /^[a-f0-9]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");

  if (key.length !== 32) {
    throw new Error("Credential encryption key must decode to exactly 32 bytes");
  }

  return key;
}

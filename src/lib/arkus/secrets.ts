// AES-256-GCM encryption for stored connection strings. The key comes from ARKUS_SECRET_KEY
// (base64, 32 bytes) or a key file at ~/.arkus/secret.key created on first use. Ciphertext
// format: "v1:<iv b64>:<tag b64>:<data b64>". Nothing here logs plaintext or key material.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "v1:";
let cachedKey: Buffer | null = null;

export function keyFilePath(): string {
  return path.join(os.homedir(), ".arkus", "secret.key");
}

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const envKey = process.env.ARKUS_SECRET_KEY;
  if (envKey && envKey.trim()) {
    const buf = Buffer.from(envKey.trim(), "base64");
    if (buf.length !== 32) throw new Error("ARKUS_SECRET_KEY must be 32 bytes, base64 encoded");
    cachedKey = buf;
    return buf;
  }
  const file = keyFilePath();
  try {
    const buf = fs.readFileSync(file);
    if (buf.length === 32) { cachedKey = buf; return buf; }
    // Tolerate a base64 text key file too.
    const dec = Buffer.from(buf.toString("utf8").trim(), "base64");
    if (dec.length === 32) { cachedKey = dec; return dec; }
    throw new Error(`key file ${file} is not 32 bytes`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const key = randomBytes(32);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* windows */ }
  fs.writeFileSync(file, key, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  cachedKey = key;
  return key;
}

export function isEncrypted(s: unknown): s is string {
  return typeof s === "string" && s.startsWith(PREFIX) && s.split(":").length === 4;
}

export function encrypt(plain: string): string {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
}

export function decrypt(cipherText: string): string {
  if (!isEncrypted(cipherText)) throw new Error("not an Arkus v1 ciphertext");
  const [, ivB64, tagB64, dataB64] = cipherText.split(":");
  const key = loadKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("could not decrypt the stored connection string (key changed?) - reconnect the database");
  }
}

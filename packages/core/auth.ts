import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { db, now, id, put, get } from "./db.js";
import { config } from "./config.js";
import { ProfileSchema } from "./schemas.js";
const keyPath = path.join(config.dataDir, ".encryption-key");
if (!existsSync(keyPath))
  writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
const key = readFileSync(keyPath);
export function encrypt(value: any) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("hex"),
  };
}
export function decrypt(value: any) {
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(value.iv, "hex"),
  );
  cipher.setAuthTag(Buffer.from(value.tag, "hex"));
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(value.data, "hex")),
      cipher.final(),
    ]).toString(),
  );
}
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  return timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(hash, "hex"),
  );
}
export function newUser(email: string, name: string, password?: string) {
  const userId = id();
  db.prepare(
    "INSERT INTO users(id,email,password_hash,name,created_at) VALUES(?,?,?,?,?)",
  ).run(
    userId,
    email.toLowerCase(),
    password ? passwordHash(password) : null,
    name,
    now(),
  );
  put("profile", userId, userId, ProfileSchema.parse({ name, email }));
  return { id: userId, email, name };
}
export function session(res: Response, userId: string) {
  const token = randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
  ).run(
    createHash("sha256").update(token).digest("hex"),
    userId,
    new Date(Date.now() + 7 * 86400000).toISOString(),
  );
  res.cookie("autopilot_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.appUrl.startsWith("https:"),
    maxAge: 7 * 86400000,
    path: "/",
  });
}
export function currentUser(req: Request) {
  const raw = req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("autopilot_session="))
    ?.split("=")[1];
  if (!raw) return null;
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const s = db
    .prepare("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?")
    .get(tokenHash, now()) as any;
  if (!s) return null;
  return db
    .prepare("SELECT id,email,name FROM users WHERE id=?")
    .get(s.user_id) as any;
}
export function auth(req: Request, res: Response, next: NextFunction) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Sign in to continue" });
  (req as any).user = user;
  next();
}
export function checkOrigin(req: Request, res: Response, next: NextFunction) {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
    const origin = req.headers.origin;
    if (
      origin !== new URL(config.appUrl).origin &&
      origin !== new URL(config.workerUrl).origin
    )
      return res.status(403).json({ error: "Origin is not allowed" });
  }
  next();
}
export function storeTokens(userId: string, tokens: any) {
  put("credential", userId, userId, {
    encrypted: encrypt(tokens),
    generation: randomBytes(16).toString("hex"),
  });
}
export function tokenConnection(userId: string) {
  const value = get("credential", userId, userId);
  return value
    ? { tokens: decrypt(value.encrypted), generation: value.generation || null }
    : undefined;
}
export function rotateTokens(
  userId: string,
  patch: any,
  generation: string | null,
) {
  const current = get("credential", userId, userId);
  if (!current || (current.generation || null) !== generation) return false;
  put("credential", userId, userId, {
    ...current,
    encrypted: encrypt({ ...decrypt(current.encrypted), ...patch }),
  });
  return true;
}
export function loadTokens(userId: string) {
  return tokenConnection(userId)?.tokens;
}

import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Letters and digits that can't be confused with each other (no 0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

/** A fresh pairing code, shown grouped for reading: `K7QM-3XWD`. */
export function newPairingCode(): string {
	const chars = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
	return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** The code as compared: upper case, letters and digits only. Typing it with spaces or dashes still works. */
export function normalizeCode(code: string | undefined): string {
	return String(code ?? "")
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
}

export const randomNonce = (): string => randomBytes(16).toString("hex");

export function hmac(code: string, message: string): string {
	return createHmac("sha256", normalizeCode(code)).update(message).digest("hex");
}

/** What the module must send back for `nonce`. */
export const clientAuth = (code: string, nonce: string): string => hmac(code, `client:${nonce}`);

/** What the plugin sends to prove it knows the code too. */
export const serverProof = (code: string, cnonce: string): string => hmac(code, `server:${cnonce}`);

/** Constant-time comparison of two hex digests. */
export function sameDigest(a: unknown, b: string): boolean {
	if (typeof a !== "string" || a.length !== b.length) {
		return false;
	}
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

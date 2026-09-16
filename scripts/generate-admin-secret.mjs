import { pbkdf2Sync, randomBytes } from "node:crypto";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
const random = randomBytes(24);
const password = Array.from(random, (byte) => alphabet[byte % alphabet.length]).join("");
const salt = randomBytes(16);
const iterations = 210_000;
const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");

console.log("Initial admin password (share securely, then discard this output):");
console.log(password);
console.log("\nADMIN_PASSWORD_HASH Cloudflare secret:");
console.log(`pbkdf2-sha256$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`);
console.log("\nAUTH_RATE_LIMIT_SECRET Cloudflare secret:");
console.log(randomBytes(32).toString("base64url"));

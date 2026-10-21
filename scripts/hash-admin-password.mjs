import { pbkdf2Sync, randomBytes } from "node:crypto"

const password = process.env.ADMIN_PASSWORD
if (!password || password.length < 16) {
  console.error("Set ADMIN_PASSWORD to a strong password of at least 16 characters, then run this script.")
  process.exit(1)
}

const iterations = 210000
const salt = randomBytes(16)
const digest = pbkdf2Sync(password, salt, iterations, 32, "sha256")
console.log(`pbkdf2-sha256$${iterations}$${salt.toString("base64")}$${digest.toString("base64")}`)

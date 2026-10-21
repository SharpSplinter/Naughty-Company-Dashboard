#!/usr/bin/env node
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { emitKeypressEvents } from "node:readline";

const ITERATIONS = 210_000;
const MIN_LENGTH = 14;

function promptHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Run this helper in an interactive terminal so the password can be entered without echo.");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Cancelled."));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(value);
        return;
      }
      if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
        return;
      }
      if (typeof character === "string" && character && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(character)) {
        value += character;
      }
    };
    process.stderr.write(prompt);
    emitKeypressEvents(process.stdin);
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
  });
}

try {
  const password = await promptHidden("Administrator password (input hidden): ");
  if (Array.from(password).length < MIN_LENGTH) {
    throw new Error(`Use a passphrase of at least ${MIN_LENGTH} characters.`);
  }
  const salt = randomBytes(16);
  const digest = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
  const encoded = [
    "pbkdf2-sha256",
    String(ITERATIONS),
    salt.toString("base64"),
    digest.toString("base64"),
  ].join("$");
  process.stdout.write(encoded + "\n");
  process.stderr.write("Store this hash as the Cloudflare Worker secret ADMIN_PASSWORD_HASH. Do not commit it.\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "Could not create administrator password hash.") + "\n");
  process.exitCode = 1;
}

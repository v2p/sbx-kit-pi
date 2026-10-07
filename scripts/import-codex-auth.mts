#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { hasErrorCode, isObject } from "./runtime-validation.mts";

function object(value: unknown, description: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error(`${description} must be a JSON object`);
  }
  return value;
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function jwtPayload(accessToken: string): Record<string, unknown> {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Codex access token is not a JWT");
  }

  try {
    return object(
      JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
      "Codex access token payload",
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("must be a JSON object")) {
      throw error;
    }
    throw new Error("Codex access token has an invalid JWT payload", { cause: error });
  }
}

async function readJson(path: string, description: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${description} at ${path}`, { cause: error });
  }
}

async function readExistingAuth(path: string): Promise<Record<string, unknown>> {
  try {
    return object(await readJson(path, "Pi authentication file"), "Pi authentication file");
  } catch (error) {
    if (error instanceof Error && hasErrorCode(error.cause, "ENOENT")) {
      return {};
    }
    throw error;
  }
}

async function main() {
  const [sourcePath, targetPath] = process.argv.slice(2);
  if (!sourcePath || !targetPath) {
    throw new Error("Usage: import-codex-auth.mts CODEX_AUTH_JSON PI_AUTH_JSON");
  }

  const source = object(
    await readJson(sourcePath, "Codex authentication file"),
    "Codex authentication file",
  );
  const tokens = object(source.tokens, "Codex authentication tokens");
  const access = requiredString(tokens.access_token, "Codex access token");
  const refresh = requiredString(tokens.refresh_token, "Codex refresh token");
  const claims = jwtPayload(access);

  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= 0) {
    throw new Error("Codex access token is missing a valid expiration claim");
  }

  const credential: {
    type: "oauth";
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
  } = {
    type: "oauth",
    access,
    refresh,
    expires: Math.trunc(claims.exp * 1000),
  };

  const tokenAccountId = tokens.account_id;
  const accountClaims = claims["https://api.openai.com/auth"];
  const claimAccountId = isObject(accountClaims) ? accountClaims.chatgpt_account_id : undefined;
  const accountId =
    typeof tokenAccountId === "string" && tokenAccountId.length > 0
      ? tokenAccountId
      : claimAccountId;
  if (typeof accountId === "string" && accountId.length > 0) {
    credential.accountId = accountId;
  }

  const target = await readExistingAuth(targetPath);
  target["openai-codex"] = credential;

  const targetDirectory = dirname(targetPath);
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    targetDirectory,
    `.auth.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  try {
    await writeFile(temporaryPath, `${JSON.stringify(target, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error(`Failed to import Codex credentials: ${error.message}`);
  process.exitCode = 1;
});

// DynamoDB Local helper: download, start, stop. ESM, node builtins only (+ the `tar` CLI).
// Used by `pnpm ddb:local`, by vitest global setup, and by the api dev server.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export const DDB_LOCAL_DIR = path.join(root, ".dynamodb-local");
const DOWNLOAD_URL = "https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz";

function javaWorks(bin) {
  try {
    return spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** $JAVA_HOME/bin/java, then `java` on PATH (if it actually runs), then Homebrew's keg-only openjdk@21 / openjdk. */
export function resolveJava() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, "bin", "java"));
  // Prefer Homebrew's openjdk@21 (matches CI's Java 21), then the latest openjdk.
  candidates.push(
    "java",
    "/opt/homebrew/opt/openjdk@21/bin/java",
    "/opt/homebrew/opt/openjdk/bin/java",
  );
  for (const c of candidates) {
    if ((c === "java" || existsSync(c)) && javaWorks(c)) return c;
  }
  throw new Error(
    "Java not found. DynamoDB Local needs a JRE: install one (e.g. `brew install openjdk`) or set JAVA_HOME.",
  );
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Downloads + verifies + extracts DynamoDB Local into `.dynamodb-local/` if the jar is missing. */
export async function ensureDynamoDbLocal() {
  const jar = path.join(DDB_LOCAL_DIR, "DynamoDBLocal.jar");
  if (existsSync(jar)) return DDB_LOCAL_DIR;

  await mkdir(DDB_LOCAL_DIR, { recursive: true });
  console.log("Downloading DynamoDB Local...");
  const [archive, shaText] = await Promise.all([
    download(DOWNLOAD_URL),
    download(`${DOWNLOAD_URL}.sha256`).then((b) => b.toString("utf8")),
  ]);
  const expected = shaText.trim().split(/\s+/)[0]?.toLowerCase();
  const actual = createHash("sha256").update(archive).digest("hex");
  if (!expected || expected !== actual) {
    throw new Error(`DynamoDB Local checksum mismatch: expected ${expected}, got ${actual}`);
  }

  // Extract into a private temp dir, then move into place (safe against concurrent callers).
  const tmp = await mkdtemp(path.join(DDB_LOCAL_DIR, ".extract-"));
  try {
    const tarball = path.join(tmp, "ddb.tar.gz");
    await writeFile(tarball, archive);
    const out = path.join(tmp, "out");
    await mkdir(out);
    const res = spawnSync("tar", ["-xzf", tarball, "-C", out], { stdio: "inherit" });
    if (res.status !== 0) throw new Error("tar extraction of DynamoDB Local failed");
    for (const entry of await readdir(out)) {
      if (existsSync(path.join(DDB_LOCAL_DIR, entry))) continue;
      await rename(path.join(out, entry), path.join(DDB_LOCAL_DIR, entry)).catch(() => {});
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  if (!existsSync(jar))
    throw new Error("DynamoDB Local extraction did not produce DynamoDBLocal.jar");
  return DDB_LOCAL_DIR;
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function listTablesOk(endpoint) {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "DynamoDB_20120810.ListTables",
        authorization:
          "AWS4-HMAC-SHA256 Credential=local/20260101/us-east-1/dynamodb/aws4_request, SignedHeaders=host, Signature=local",
      },
      body: "{}",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Starts DynamoDB Local. Returns `{ endpoint, stop() }`.
 * @param {{ port?: number, inMemory?: boolean, dbPath?: string, timeoutMs?: number }} [opts]
 */
export async function startDynamoDbLocal({
  port,
  inMemory = true,
  dbPath,
  timeoutMs = 30_000,
} = {}) {
  const dir = await ensureDynamoDbLocal();
  const java = resolveJava();
  const listenPort = port ?? (await getFreePort());
  const args = [
    `-Djava.library.path=${path.join(dir, "DynamoDBLocal_lib")}`,
    "-jar",
    path.join(dir, "DynamoDBLocal.jar"),
    "-port",
    String(listenPort),
  ];
  if (inMemory) {
    args.push("-inMemory");
  } else {
    const data = dbPath ?? path.join(dir, "data");
    await mkdir(data, { recursive: true });
    args.push("-sharedDb", "-dbPath", data);
  }

  const child = spawn(java, args, { stdio: ["ignore", "pipe", "pipe"], cwd: dir });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  let exited = false;
  const exitPromise = new Promise((resolve) =>
    child.once("exit", () => {
      exited = true;
      resolve(undefined);
    }),
  );

  const stop = async () => {
    if (!exited) {
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exitPromise;
      clearTimeout(killer);
    }
  };
  process.once("exit", () => {
    if (!exited) child.kill("SIGKILL");
  });

  const endpoint = `http://localhost:${listenPort}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`DynamoDB Local exited during startup:\n${output}`);
    if (await listTablesOk(endpoint)) return { endpoint, stop };
    await new Promise((r) => setTimeout(r, 200));
  }
  await stop();
  throw new Error(`DynamoDB Local did not become ready within ${timeoutMs}ms:\n${output}`);
}

// CLI: persistent instance on :8000, runs until killed.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.DDB_PORT ?? 8000);
  const { endpoint, stop } = await startDynamoDbLocal({
    port,
    inMemory: false,
    dbPath: path.join(DDB_LOCAL_DIR, "data"),
  });
  console.log(`DynamoDB Local listening on ${endpoint} (data: .dynamodb-local/data)`);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {});
}

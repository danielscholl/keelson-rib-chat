#!/usr/bin/env bun
/**
 * Start, stop, or inspect the ClickClack the rib manages, by hand. It is the
 * same server the rib would start (same data directory, port, and record), so
 * a running Keelson adopts it. A server started here stays up when Keelson
 * shuts down; stop it here or with chat_server_stop.
 *
 *   bun dev/server.ts start | stop | status
 *
 * KEELSON_HOME selects the Keelson whose rib data directory is used, resolved
 * the way Keelson resolves it.
 */
import { ribDataDir } from "@keelson/shared/paths";
import { ManagedServer, realServerDeps } from "../src/server.ts";

const dataDir = ribDataDir("chat");
const server = new ManagedServer(realServerDeps(() => dataDir, { operator: true }));
const verb = process.argv[2];

try {
  if (verb === "start") {
    const { url, pid, adopted } = await server.ensure();
    console.log(`ClickClack ${adopted ? "already running" : "started"} at ${url} (pid ${pid})`);
    console.log(`  UI    ${url}/app`);
    console.log(`  data  ${dataDir}/clickclack`);
  } else if (verb === "stop") {
    console.log((await server.stop()) ? "ClickClack stopped." : "ClickClack was not running.");
  } else if (verb === "status") {
    const status = await server.status();
    console.log(JSON.stringify(status, null, 1));
    if (status.running) console.log(`UI  ${status.url}/app`);
  } else {
    console.error("usage: bun dev/server.ts start | stop | status");
    process.exit(2);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

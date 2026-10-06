// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Every key the Swarms tab reads, all under the rib's own namespace.
export const SURFACE_ID = "swarms";
// The host names a rib's surface tab by rib and surface id.
export const SURFACE_TAB = `surface:swarm:${SURFACE_ID}`;
export const INDEX_KEY = "rib:swarm:swarms";
// The count on the Swarms tab: live swarms waiting on the operator.
export const BADGE_KEY = "rib:swarm:swarms-badge";
export const HISTORY_KEY = "rib:swarm:history";

export function swarmKey(id: string): string {
  return `rib:swarm:swarm:${id}`;
}

export function agentKey(id: string): string {
  return `rib:swarm:agent:${id}`;
}

export function askKey(id: string): string {
  return `rib:swarm:ask:${id}`;
}

export function gateKey(id: string): string {
  return `rib:swarm:gate:${id}`;
}

export function detailsKey(id: string): string {
  return `rib:swarm:details:${id}`;
}

export function docKey(id: string): string {
  return `rib:swarm:doc:${id}`;
}
export const LAUNCH_KEY = "rib:swarm:launch";
export const SERVER_KEY = "rib:swarm:server";
export const SERVER_LOG_KEY = "rib:swarm:server-log";

export function reportKey(id: string): string {
  return `rib:swarm:report:${id}`;
}

export function recordKey(id: string): string {
  return `rib:swarm:record:${id}`;
}

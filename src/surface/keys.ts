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
export const SURFACE_TAB = `surface:chat:${SURFACE_ID}`;
export const INDEX_KEY = "rib:chat:swarms";
// The count on the Swarms tab: live swarms waiting on the operator.
export const BADGE_KEY = "rib:chat:swarms-badge";
export const HISTORY_KEY = "rib:chat:history";

export function swarmKey(id: string): string {
  return `rib:chat:swarm:${id}`;
}

export function docKey(id: string): string {
  return `rib:chat:doc:${id}`;
}
export const LAUNCH_KEY = "rib:chat:launch";
export const SERVER_KEY = "rib:chat:server";
export const SERVER_LOG_KEY = "rib:chat:server-log";

export function reportKey(id: string): string {
  return `rib:chat:report:${id}`;
}

export function recordKey(id: string): string {
  return `rib:chat:record:${id}`;
}

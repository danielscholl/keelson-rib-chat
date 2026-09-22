// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Every key the Swarms tab reads, all under the rib's own namespace.
export const SURFACE_ID = "swarms";
export const INDEX_KEY = "rib:chat:swarms";
export const HISTORY_KEY = "rib:chat:history";

export function swarmKey(id: string): string {
  return `rib:chat:swarm:${id}`;
}

export function docKey(id: string): string {
  return `rib:chat:doc:${id}`;
}
export const LAUNCH_KEY = "rib:chat:launch";

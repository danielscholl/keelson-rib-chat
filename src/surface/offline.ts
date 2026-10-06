// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import type { ServerLine } from "./parts.ts";

export const OFFLINE_NOTE =
  "ClickClack is stopped, so transcript and message links are off. Start it from Server › Manage.";

export function serverDown(server: ServerLine | undefined): server is ServerLine & { url: string } {
  return Boolean(server && !server.running && server.url);
}

// A link into a stopped ClickClack opens a browser error page, so a board drops
// those links and says why once.
export function offlineLinks(
  view: CanvasBoardView,
  server: ServerLine | undefined,
): CanvasBoardView {
  if (!serverDown(server)) return view;
  const base = server.url.replace(/\/+$/, "");
  let dropped = 0;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== "object" || value === null) return value;
    const entry = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const offline = typeof entry.href === "string" && entry.href.startsWith(`${base}/`);
    for (const [key, v] of Object.entries(entry)) {
      if (offline && key === "href") continue;
      if (offline && (key === "text" || key === "value") && typeof v === "string") {
        out[key] = v.replace(/\s*↗$/, "");
        continue;
      }
      out[key] = walk(v);
    }
    if (offline) dropped++;
    return out;
  };
  const next = walk(view) as CanvasBoardView;
  if (dropped === 0) return view;
  return {
    ...next,
    sections: [...next.sections, { kind: "rows", items: [{ icon: "◌", text: OFFLINE_NOTE }] }],
  };
}

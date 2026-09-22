// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type DesignThemeName,
  formatPaletteReport,
  validateCategoricalPalette,
} from "@keelson/shared";
import type { ReportMeta } from "./types.ts";

export const REPORT_DIR = "reports";
export const REPORT_HTML_MAX = 512 * 1024;
export const REPORT_TITLE_MAX = 80;

// The lead's designed page: a self-contained HTML body the host renders in a
// sandboxed frame, the same contract as Keelson's canvas_publish.
export interface SwarmReport {
  title: string;
  html: string;
  at: string;
}

export function isReport(value: unknown): value is SwarmReport {
  const r = value as SwarmReport;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.title === "string" &&
    typeof r.html === "string" &&
    r.html.length > 0 &&
    typeof r.at === "string"
  );
}

export function reportMeta(r: SwarmReport): ReportMeta {
  return { title: r.title, at: r.at, bytes: Buffer.byteLength(r.html, "utf8") };
}

function declaredPalette(html: string, attr: string): string[] | undefined {
  const match = html.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']*)["']`, "i"));
  const list = match?.[1]
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list && list.length > 0 ? list : undefined;
}

// The checks canvas_publish makes: the frame's CSP blocks external assets, and
// a declared categorical palette must pass color-vision and contrast checks.
export function checkReport(html: string): string | undefined {
  if (Buffer.byteLength(html, "utf8") > REPORT_HTML_MAX) {
    return `the page is over ${REPORT_HTML_MAX / 1024} KB; cut it down`;
  }
  if (/<script\b[^>]*\bsrc\s*=/i.test(html)) {
    return "external <script src> is blocked by the frame CSP; inline all script";
  }
  if (/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(html)) {
    return "external stylesheets are blocked by the frame CSP; inline all CSS in a <style> block";
  }
  const both = declaredPalette(html, "data-palette");
  for (const mode of ["dark", "light"] as const satisfies readonly DesignThemeName[]) {
    const palette = declaredPalette(html, `data-palette-${mode}`) ?? both;
    if (!palette) continue;
    let report: ReturnType<typeof validateCategoricalPalette>;
    try {
      report = validateCategoricalPalette(palette, { mode });
    } catch (e) {
      return `data-palette-${mode}: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (!report.ok) {
      return `the declared ${mode} palette fails validation; fix the colors (canvas_design_guide section "color" has the keelson series) and call again:\n${formatPaletteReport(report)}`;
    }
  }
  return undefined;
}

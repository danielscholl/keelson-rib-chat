// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { SIZE_PRESETS, SWARM_SIZES, type SwarmSize, type SwarmSummary } from "../types.ts";
import { sizesHint } from "./index-board.ts";

type ActionsSection = Extract<CanvasBoardView["sections"][number], { kind: "actions" }>;
type Item = ActionsSection["items"][number];
type Field = NonNullable<Item["fields"]>[number];

export interface LaunchState {
  projects: readonly { id: string; name: string }[];
  // Why Dispatch can't run on this host, when it can't.
  dispatchBlocked?: string;
  live: number;
}

export const DISCUSS_SUBTITLE = "Agents talk it through in #swarm-<id> and conclude.";

// The region byline: every size's agents and wall clock, in one line.
export function sizesByline(): string {
  return SWARM_SIZES.map((k, i) => {
    const l = SIZE_PRESETS[k];
    const agents = i === 0 ? `${l.maxAgents} agents` : String(l.maxAgents);
    return `${k} ${agents} · ${l.wallClockMs / 60_000} min`;
  }).join("  ·  ");
}

export function sizeField(defaultValue: SwarmSize = "medium"): Field {
  return {
    name: "size",
    label: "Size",
    required: true,
    segmented: true,
    half: true,
    defaultValue,
    options: SWARM_SIZES.map((k) => ({ value: k, label: k })),
  };
}

export function modelField(model?: string, provider?: string): Field {
  return {
    name: "model",
    label: "Model",
    placeholder: "provider default",
    half: true,
    ...(model ? { defaultValue: model } : {}),
    modelPicker: { providerField: "provider", ...(provider ? { providerDefault: provider } : {}) },
  };
}

function fields(state: LaunchState, dispatch: boolean): Field[] {
  const hasProjects = state.projects.length > 0;
  return [
    {
      name: "task",
      label: "Task",
      required: true,
      multiline: true,
      placeholder: "What should the swarm work out? Name the issue, PR or question.",
    },
    ...(hasProjects
      ? [
          {
            name: "project",
            label: "Project",
            half: true,
            ...(dispatch
              ? { required: true, defaultValue: state.projects[0]?.id ?? "" }
              : { placeholder: "no project" }),
            options: state.projects.map((p) => ({ value: p.id, label: p.name })),
          },
          {
            name: "tools",
            label: "Agents may",
            required: true,
            segmented: true,
            half: true,
            defaultValue: "read",
            options: [
              { value: "none", label: "chat only" },
              { value: "read", label: "read the project" },
            ],
          },
        ]
      : []),
    ...(dispatch
      ? [
          {
            name: "workflows",
            label: "Workflows the lead may start",
            required: true,
            placeholder: "fix-issue",
          },
        ]
      : []),
    sizeField(),
    modelField(),
  ];
}

export function buildLaunch(state: LaunchState): CanvasBoardView {
  const hint = `Sizes: ${sizesHint()}.`;
  const blocked =
    state.dispatchBlocked ??
    (state.projects.length === 0
      ? "Register a project first: dispatched runs need one."
      : undefined);
  const items: Item[] = [
    {
      type: "start-swarm",
      label: "Discuss",
      subtitle: DISCUSS_SUBTITLE,
      fields: fields(state, false),
      submitLabel: "Start swarm",
      submitTone: "brand",
      hint,
      binding: { mode: "discuss" },
      ...(state.live === 0 ? { defaultOpen: true } : {}),
    },
    {
      type: "start-swarm",
      label: "Dispatch",
      subtitle: "The lead may start the named workflows in isolated worktrees.",
      fields: fields(state, true),
      submitLabel: "Start swarm",
      submitTone: "brand",
      hint,
      binding: { mode: "dispatch" },
      ...(blocked ? { disabled: true, reason: blocked } : {}),
    },
    {
      type: "start-in-chat",
      label: "In chat",
      subtitle: "Talk it through first; attach issue and PR context.",
      hint: "Opens a chat that gathers issue and PR context, then starts the swarm.",
    },
  ];
  return {
    view: "board",
    title: "Start a swarm",
    sections: [{ kind: "actions", tabs: true, items }],
  };
}

// Run again reads the old swarm's size and model as its defaults.
export function runAgainItem(s: SwarmSummary): Item {
  return {
    type: "run-again",
    label: "Run again",
    glyph: "↻",
    hint: "Starts a new swarm with the same task, project, workflows and context.",
    fields: [sizeField(s.sizeBase), modelField(s.model, s.provider)],
    submitLabel: "Run again",
    binding: { id: s.id },
  };
}

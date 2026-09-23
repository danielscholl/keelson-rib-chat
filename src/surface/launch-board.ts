// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, ModelClassMap } from "@keelson/shared";
import type { StartSwarmInput } from "../tools.ts";
import {
  SIZE_PRESETS,
  SWARM_POWERS,
  SWARM_SIZES,
  type SwarmPower,
  type SwarmSize,
  type SwarmSummary,
} from "../types.ts";
import { day, hhmm, plural } from "./format.ts";
import { sizesHint } from "./parts.ts";

type ActionsSection = Extract<CanvasBoardView["sections"][number], { kind: "actions" }>;
type Item = ActionsSection["items"][number];
type Field = NonNullable<Item["fields"]>[number];

export interface LaunchState {
  projects: readonly { id: string; name: string }[];
  // Why the lead can't dispatch workflows on this host, when it can't.
  dispatchBlocked?: string;
  live: number;
  // Each provider's class map, for the hover on each power.
  classes?: readonly { provider: string; classes: ModelClassMap }[];
  // Workflows whose approvals the host keeps for the operator.
  refused?: readonly string[];
}

export const TASK_PLACEHOLDER =
  "What should the swarm work out? Agents can't open links: describe the issue or PR here, or Prepare in chat to attach it.";

// The region byline: every size's agents and wall clock, in one line.
export function sizesByline(): string {
  return SWARM_SIZES.map((k, i) => {
    const l = SIZE_PRESETS[k];
    const agents = i === 0 ? `${l.maxAgents} agents` : String(l.maxAgents);
    return `${k} ${agents} · ${l.maxTurns} turns · ${l.wallClockMs / 60_000} min`;
  }).join("  ·  ");
}

// Each segment carries what the size costs, since the word alone does not.
export function sizeField(defaultValue: SwarmSize = "medium"): Field {
  return {
    name: "size",
    label: "Size",
    required: true,
    segmented: true,
    half: true,
    defaultValue,
    options: SWARM_SIZES.map((k) => {
      const l = SIZE_PRESETS[k];
      return {
        value: k,
        label: `${k} · ${l.maxAgents} agents · ${l.maxTurns} turns`,
        hint: `${l.maxTurnsPerAgent} turns per worker · ${l.maxConcurrent} at once · ${l.wallClockMs / 60_000} min`,
      };
    }),
  };
}

// The hover names the model each provider runs at that power.
export function powerField(
  defaultValue: SwarmPower = "balanced",
  classes: LaunchState["classes"] = [],
): Field {
  return {
    name: "power",
    label: "Power",
    required: true,
    segmented: true,
    half: true,
    defaultValue,
    options: SWARM_POWERS.map((k) => {
      const hint = classes.map((c) => `${c.provider}: ${c.classes[k]}`).join(" · ");
      return { value: k, label: k, ...(hint ? { hint: hint.slice(0, 200) } : {}) };
    }),
  };
}

export function modelField(model?: string, provider?: string): Field {
  return {
    name: "model",
    label: "Model override",
    placeholder: "use the power's model",
    half: true,
    ...(model ? { defaultValue: model } : {}),
    modelPicker: { providerField: "provider", ...(provider ? { providerDefault: provider } : {}) },
  };
}

// Workflows and read access need a project; they stay hidden until one is picked.
const ONCE_A_PROJECT = { field: "project" };

// The workflows field says who answers their approvals, from the refusals the
// host has made so far, where the decision it informs is made.
function workflowsField(state: LaunchState): Field {
  const refused = state.refused ?? [];
  const approvals =
    refused.length > 0 ? ` · ${refused.join(", ")} approvals: you answer them in Workflows` : "";
  const placeholder = state.dispatchBlocked
    ? state.dispatchBlocked
    : state.projects.length === 0
      ? "needs a registered project"
      : `none: the swarm investigates · e.g. fix-issue${approvals}`;
  return {
    name: "workflows",
    label: "Workflows the lead may start",
    placeholder,
    ...(state.projects.length > 0 && !state.dispatchBlocked ? { showWhen: ONCE_A_PROJECT } : {}),
  };
}

function fields(state: LaunchState): Field[] {
  const hasProjects = state.projects.length > 0;
  return [
    {
      name: "task",
      label: "Task",
      required: true,
      multiline: true,
      placeholder: TASK_PLACEHOLDER,
    },
    ...(hasProjects
      ? [
          {
            name: "project",
            label: "Project",
            half: true,
            placeholder: "no project",
            options: state.projects.map((p) => ({ value: p.id, label: p.name })),
          },
          {
            name: "tools",
            label: "Agents may",
            showWhen: ONCE_A_PROJECT,
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
    workflowsField(state),
    sizeField(),
    powerField("balanced", state.classes),
    modelField(),
  ];
}

// One form. A swarm with no workflows named investigates; one with workflows
// named may dispatch them. Prepare in chat gathers evidence first.
export function buildLaunch(state: LaunchState): CanvasBoardView {
  const items: Item[] = [
    {
      type: "start-swarm",
      label: "Start a swarm",
      glyph: "▶",
      fields: fields(state),
      submitLabel: "Start swarm",
      submitTone: "brand",
      pendingLabel: "Starting…",
      hint: `Sizes: ${sizesHint()}.`,
      ...(state.live === 0 ? { expanded: true } : {}),
    },
    {
      type: "start-in-chat",
      label: "Prepare in chat",
      glyph: "→",
      hint: "Opens a chat that gathers issue and PR context, then starts the swarm with it attached.",
    },
  ];
  return {
    view: "board",
    title: "Start a swarm",
    sections: [{ kind: "actions", wrap: true, items }],
  };
}

// Run again reads the old swarm's size, power and model as its defaults, and
// its hint names what it reuses, so stale evidence is rerun on purpose.
export function runAgainItem(s: SwarmSummary, launch: StartSwarmInput): Item {
  const context = launch.context ?? [];
  const captured = context
    .map((c) => c.retrievedAt)
    .filter((t): t is string => Boolean(t))
    .sort()[0];
  const reuses = [
    "the same task",
    ...(launch.project ? ["project"] : []),
    ...(launch.workflows?.length
      ? [`workflows (${launch.workflows.map((w) => w.name).join(", ")})`]
      : []),
    ...(context.length > 0
      ? [
          `${plural(context.length, "context item")}${captured ? ` captured ${day(captured)} ${hhmm(captured)}` : ""}`,
        ]
      : []),
  ];
  return {
    type: "run-again",
    label: "Run again",
    glyph: "↻",
    hint: `Starts a new swarm with ${reuses.join(", ")}. Context is not refreshed.`,
    fields: [sizeField(s.sizeBase), powerField(s.power), modelField(s.model, s.provider)],
    submitLabel: "Run again",
    binding: { id: s.id },
  };
}

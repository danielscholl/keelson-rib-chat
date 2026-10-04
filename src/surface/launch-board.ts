// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { homedir } from "node:os";
import {
  type CanvasBoardView,
  DEFAULT_PROJECT_NAME,
  designTokenCssBlock,
  type ModelClassMap,
  type ToolReachability,
} from "@keelson/shared";
import { START_BOUNDS, type StartSwarmInput } from "../tools.ts";
import {
  pinnedModels,
  SIZE_PRESETS,
  SWARM_POWERS,
  SWARM_SIZES,
  type SwarmPower,
  type SwarmSize,
  type SwarmSummary,
} from "../types.ts";
import { WORKFLOW } from "./actions.ts";
import { day, hhmm, plural } from "./format.ts";
import { esc } from "./record.ts";

type ActionsSection = Extract<CanvasBoardView["sections"][number], { kind: "actions" }>;
type Item = ActionsSection["items"][number];
type Field = NonNullable<Item["fields"]>[number];

export interface LaunchState {
  projects: readonly { id: string; name: string; rootPath: string }[];
  provider?: string;
  // Each provider's class map, for the hover on each power.
  classes?: readonly { provider: string; classes: ModelClassMap }[];
  toolReachability?: readonly ToolReachability[];
  refused?: readonly string[];
  dispatchBlocked?: string;
}

export const TRACKER_TOOLS = [
  "beads_ready",
  "beads_show",
  "beads_create",
  "beads_update",
  "beads_close",
  "beads_dep",
] as const;

export const TASK_PLACEHOLDER =
  "What should the swarm work out? Describe the issue or PR in words. A question works; so does a paste of the issue body.";

export function launchByline(): string {
  return "Agents investigate, debate, and bring back a conclusion.";
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
      const hint = classes
        .map((c) => {
          const pin = pinnedModels(c.provider, k);
          if (pin) {
            return pin.lead === pin.worker
              ? `${c.provider}: ${pin.lead}`
              : `${c.provider}: lead ${pin.lead} · workers ${pin.worker}`;
          }
          const same =
            c.classes.fast === c.classes.balanced && c.classes.balanced === c.classes.deep;
          return `${c.provider}: ${c.classes[k]}${same ? " (every power)" : ""}`;
        })
        .join(" · ");
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

const PAGE_CSS = `
:root { --button-ink: var(--bg); }
:root[data-theme="light"] { --button-ink: var(--card); }
body { font-size: 14px; }
* { box-sizing: border-box; }
main { margin: 0 auto; max-width: 1120px; border: 1px solid var(--border);
  border-radius: 12px; overflow: hidden; background: var(--card); }
header { display: flex; align-items: center; gap: 14px; padding: 24px; flex-wrap: wrap; }
.glyph { display: grid; place-items: center; width: 44px; height: 44px; flex: none;
  border-radius: 12px; background: var(--card-2); color: var(--accent); }
.intro { flex: 1; min-width: 220px; }
h1 { font-size: 22px; line-height: 1.3; margin: 0 0 5px; color: var(--fg-strong); }
p { margin: 0; }
.hint { color: var(--muted); font-size: 13px; }
button, textarea, select, input { font: inherit; }
button { cursor: pointer; border: 1px solid var(--border); border-radius: 8px; padding: 10px 16px; }
.prepare { border-radius: 999px; color: var(--fg); background: var(--card-2); }
.fields { padding: 0 24px 24px; }
label { display: block; font-size: 12px; font-weight: 600; letter-spacing: .08em; margin-bottom: 8px; }
textarea, select { display: block; width: 100%; border: 1px solid var(--border);
  border-radius: 8px; padding: 12px; color: var(--fg); background: var(--bg); }
textarea { resize: vertical; min-height: 112px; line-height: 1.5; }
textarea::placeholder { color: var(--muted); opacity: 1; }
.task-hint { margin-top: 8px; }
.project { margin-top: 24px; }
.project > .hint { margin: -2px 0 12px; }
.project-row { display: grid; grid-template-columns: minmax(200px, 1fr) minmax(240px, 1fr); gap: 16px; align-items: start; }
.project-note { padding: 12px 16px; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px; }
.project-row.has-project { grid-template-columns: 1fr; }
.has-project .project-note { border: 0; padding: 0; }
.access { margin-top: 24px; }
.access-heading { font-size: 12px; letter-spacing: .08em; margin: 0 0 8px; }
.access-row { display: grid; grid-template-columns: 8px 44px minmax(150px, 1fr) minmax(240px, 2fr);
  gap: 14px; align-items: center; padding: 16px 0; border-top: 1px solid var(--border); }
.access-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
.access-row.is-on .access-dot { background: var(--accent); }
.access-name { color: var(--fg-strong); font-weight: 600; }
.access-tag { display: block; font: 11px var(--mono); color: var(--muted); margin-top: 4px; }
.access-meaning { color: var(--muted); line-height: 1.5; }
.switch { width: 44px; height: 26px; padding: 3px; border-radius: 999px; background: var(--card-2); }
.switch::after { content: ""; display: block; width: 18px; height: 18px; border-radius: 50%; background: var(--muted); }
.switch[aria-checked="true"] { background: var(--accent); border-color: var(--accent); }
.switch[aria-checked="true"]::after { background: var(--button-ink); transform: translateX(18px); }
.switch:disabled { cursor: not-allowed; }
.access-details { grid-column: 4; min-width: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px;
  border: 1px solid var(--border); border-radius: 6px; font: 12px var(--mono); color: var(--fg); background: var(--card-2); }
.chip.is-muted { color: var(--muted); border-style: dashed; background: transparent; }
.chip button { padding: 0 4px; border: 0; background: transparent; color: var(--fg); }
.workflow-input { width: 100%; min-width: 0; margin-top: 10px; padding: 8px 10px;
  border: 1px dashed var(--border); border-radius: 6px; color: var(--fg); background: var(--bg); }
.workflow-input::placeholder { color: var(--muted); opacity: 1; }
.workflow-error { color: var(--fg); margin-top: 8px; }
.workflow-count { margin-top: 8px; }
footer { display: flex; gap: 18px; align-items: center; flex-wrap: wrap;
  background: var(--card-2); border-top: 1px solid var(--border); padding: 18px 24px; }
.start { background: var(--accent); color: var(--button-ink); border-color: var(--accent); font-weight: 600; }
.start:disabled { cursor: wait; }
.models { font-family: var(--mono); color: var(--muted); font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
.mode { margin-left: auto; color: var(--fg); }
button:focus-visible, textarea:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
[hidden] { display: none !important; }
@media (max-width: 640px) {
  header, footer { padding: 18px; }
  .fields { padding: 0 18px 18px; }
  .project-row { grid-template-columns: 1fr; }
  .prepare { width: 100%; }
  .mode { margin-left: 0; width: 100%; }
  .access-row { grid-template-columns: 8px 44px minmax(0, 1fr); gap: 12px; }
  .access-meaning, .access-details { grid-column: 3; }
}
`;

const PAGE_SCRIPT = `
(() => {
  const form = document.getElementById("launch-form");
  const task = document.getElementById("launch-task");
  const project = document.getElementById("launch-project");
  const start = document.getElementById("launch-start");
  const note = document.getElementById("project-note");
  const row = document.getElementById("project-row");
  const mode = document.getElementById("launch-mode");
  const chatNote = note.textContent;
  const chatMode = mode.textContent;
  const access = document.getElementById("launch-access");
  const template = document.getElementById("access-template");
  const permissions = { write: false, workflows: false, tracker: false };
  let workflows = [];
  let controls;
  const updateMode = () => {
    mode.textContent = project.value
      ? "Reads " + project.selectedOptions[0].dataset.name
        + (permissions.write ? " · writes on a branch" : "")
        + (permissions.workflows && workflows.length ? " · " + workflows.join(", ") : " · no workflows")
        + (permissions.tracker ? " · beads" : "")
      : chatMode;
  };
  const workflowError = (message) => {
    controls.error.textContent = message;
    controls.error.hidden = !message;
    controls.entry.setAttribute("aria-invalid", message ? "true" : "false");
  };
  const renderWorkflows = () => {
    controls.chips.replaceChildren();
    workflows.forEach((name) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      const label = document.createElement("span");
      label.textContent = name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Remove " + name);
      remove.addEventListener("click", () => {
        workflows = workflows.filter((value) => value !== name);
        renderWorkflows();
      });
      chip.append(label, remove);
      controls.chips.append(chip);
    });
    controls.count.textContent = workflows.length + " / ${START_BOUNDS.maxWorkflows} workflows";
    updateMode();
  };
  const addWorkflows = () => {
    const names = controls.entry.value.trim().split(/[\\s,]+/).filter(Boolean);
    const bad = names.find((name) => !${WORKFLOW}.test(name));
    if (bad) {
      workflowError("'" + bad + "' is not a workflow name");
      return false;
    }
    const next = [...new Set([...workflows, ...names])];
    if (next.length > ${START_BOUNDS.maxWorkflows}) {
      workflowError("at most ${START_BOUNDS.maxWorkflows} workflows");
      return false;
    }
    workflows = next;
    controls.entry.value = "";
    workflowError("");
    renderWorkflows();
    return true;
  };
  document.getElementById("launch-prepare").addEventListener("click", () => {
    keelson.action("start-in-chat", { nonce: form.dataset.nonce });
  });
  project.addEventListener("change", () => {
    const selected = project.selectedOptions[0];
    const hasProject = Boolean(project.value);
    row.classList.toggle("has-project", hasProject);
    note.textContent = hasProject
      ? "Agents read " + selected.dataset.path + " and run read-only commands there. Nothing changes unless you allow more."
      : chatNote;
    Object.keys(permissions).forEach((key) => { permissions[key] = false; });
    workflows = [];
    controls = undefined;
    access.replaceChildren();
    if (hasProject && template) {
      access.append(template.content.cloneNode(true));
      controls = {
        entry: document.getElementById("workflow-entry"),
        chips: document.getElementById("workflow-chips"),
        count: document.getElementById("workflow-count"),
        error: document.getElementById("workflow-error")
      };
      Object.keys(permissions).forEach((key) => {
        const button = document.getElementById("allow-" + key);
        button.addEventListener("click", () => {
          if (button.disabled || !project.value) return;
          permissions[key] = !permissions[key];
          button.setAttribute("aria-checked", String(permissions[key]));
          document.getElementById(key + "-row").classList.toggle("is-on", permissions[key]);
          if (key !== "write") document.getElementById(key + "-details").hidden = !permissions[key];
          updateMode();
        });
      });
      controls.entry.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          addWorkflows();
        }
      });
      controls.entry.addEventListener("paste", (event) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text");
        const from = controls.entry.selectionStart;
        const to = controls.entry.selectionEnd;
        controls.entry.value = controls.entry.value.slice(0, from) + text + controls.entry.value.slice(to);
        addWorkflows();
      });
      renderWorkflows();
    }
    updateMode();
  });
  // The host's frame sandbox grants allow-scripts only, never allow-forms, so a
  // form never fires submit here; Start is a plain click.
  const startSwarm = () => {
    if (start.disabled) return;
    if (permissions.workflows && !addWorkflows()) return;
    const payload = {
      nonce: form.dataset.nonce,
      task: task.value,
      project: project.value,
      tools: project.value ? (permissions.write ? "write" : "read") : "none"
    };
    if (permissions.workflows && workflows.length) payload.workflows = workflows.join(", ");
    if (permissions.tracker) {
      const names = Array.from(access.querySelectorAll('[data-tool][data-reachable="true"]'))
        .map((chip) => chip.dataset.tool);
      if (names.length) payload.lead_tools = names;
    }
    keelson.action("start-swarm", payload);
    start.disabled = true;
    start.textContent = "Starting…";
    start.setAttribute("aria-busy", "true");
    setTimeout(() => {
      start.disabled = false;
      start.textContent = "Start swarm";
      start.removeAttribute("aria-busy");
    }, 2000);
  };
  start.addEventListener("click", startSwarm);
  task.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) startSwarm();
  });
})();
`;

function projectPath(rootPath: string): string {
  const home = homedir();
  return rootPath === home || rootPath.startsWith(`${home}/`)
    ? `~${rootPath.slice(home.length)}`
    : rootPath;
}

function accessTemplate(state: LaunchState): string {
  const approvals = state.refused?.length
    ? ` · ${state.refused.join(", ")} approvals: you answer them in Workflows`
    : "";
  const workflowMeaning =
    (state.dispatchBlocked ??
      "The lead can hand the work to a workflow once the swarm agrees on it. You answer its approvals in Workflows.") +
    approvals;
  const trackerMeaning = state.toolReachability
    ? "The lead reads and updates beads for the project, and says in the channel what it changed."
    : "This host does not say which tools a lead may hold.";
  const rows = [
    {
      key: "write",
      name: "Write",
      tag: "elevated",
      meaning: "Change files. Each agent works in its own worktree on a branch, never on main.",
      disabled: false,
      details: "",
    },
    {
      key: "workflows",
      name: "Run workflows",
      tag: "elevated · needs your grant",
      meaning: workflowMeaning,
      disabled: Boolean(state.dispatchBlocked),
      details: `<div class="access-details" id="workflows-details" hidden><div class="chips" id="workflow-chips"></div><input class="workflow-input" id="workflow-entry" type="text" aria-label="Add a workflow" aria-describedby="workflow-count workflow-error" placeholder="add a workflow…" /><p class="hint workflow-count" id="workflow-count">0 / ${START_BOUNDS.maxWorkflows} workflows</p><p class="workflow-error" id="workflow-error" role="alert" hidden></p></div>`,
    },
    {
      key: "tracker",
      name: "Use the tracker",
      tag: "elevated · needs your grant",
      meaning: trackerMeaning,
      disabled: !state.toolReachability,
      details: `<div class="access-details chips" id="tracker-details" hidden>${TRACKER_TOOLS.map(
        (name) => {
          const reachable =
            state.toolReachability?.find((tool) => tool.name === name)?.status === "reachable";
          return `<span class="chip${reachable ? "" : " is-muted"}" data-tool="${esc(name)}" data-reachable="${reachable}"${reachable ? "" : ' title="needs your grant: crossRibGrants"'}>${esc(name)}</span>`;
        },
      ).join("")}</div>`,
    },
  ];
  return `<template id="access-template"><section class="access" aria-labelledby="access-heading"><h2 class="access-heading" id="access-heading">ALSO ALLOW</h2>${rows
    .map(
      (item) =>
        `<div class="access-row" id="${item.key}-row"><span class="access-dot" aria-hidden="true"></span><button class="switch" id="allow-${item.key}" type="button" role="switch" aria-label="${esc(item.name)}" aria-describedby="${item.key}-meaning" aria-checked="false"${item.disabled ? " disabled" : ""}></button><div class="access-name">${esc(item.name)}<span class="access-tag">${esc(item.tag)}</span></div><p class="access-meaning" id="${item.key}-meaning">${esc(item.meaning)}</p>${item.details}</div>`,
    )
    .join("")}</section></template>`;
}

export function buildLaunch(state: LaunchState, nonce: string): string {
  const projects = state.projects.filter((p) => p.name !== DEFAULT_PROJECT_NAME);
  const limits = SIZE_PRESETS.medium;
  const pins = pinnedModels(state.provider, "balanced");
  const classes = state.classes?.find((c) => c.provider === state.provider)?.classes;
  const models = pins
    ? `lead ${pins.lead} · workers ${pins.worker}`
    : classes
      ? `${state.provider}: ${classes.balanced}`
      : "";
  const options = projects
    .map((p) => {
      const path = projectPath(p.rootPath);
      return `<option value="${esc(p.id)}" data-name="${esc(p.name)}" data-path="${esc(path)}">${esc(`${p.name} · ${path}`)}</option>`;
    })
    .join("");
  return `<style>${designTokenCssBlock()}\n${PAGE_CSS}</style>
<main>
  <header>
    <span class="glyph" aria-hidden="true">▶</span>
    <div class="intro"><h1>Start a swarm</h1><p class="hint">Describe the problem. Agents investigate, debate, and bring back a conclusion.</p></div>
    <button class="prepare" id="launch-prepare" type="button">Prepare in chat · attach an issue or PR</button>
  </header>
  <form id="launch-form" data-nonce="${esc(nonce)}">
    <div class="fields">
      <label for="launch-task">TASK</label>
      <textarea id="launch-task" name="task" rows="4" required aria-describedby="task-hint" placeholder="${esc(TASK_PLACEHOLDER)}"></textarea>
      <p class="hint task-hint" id="task-hint">Agents can't open links. Paste the text, or use Prepare in chat to attach the issue or PR.</p>
      <div class="project">
        <label for="launch-project">PROJECT</label>
        <p class="hint" id="project-hint">Picking one lets agents read it. Anything more is a switch.</p>
        <div class="project-row" id="project-row">
          <select id="launch-project" name="project" aria-describedby="project-hint project-note">
            <option value="" selected>No project · chat only</option>${options}
          </select>
          <p class="project-note" id="project-note">Chat mode. Agents work from the task and anything you attach. Nothing on disk is read or changed. Pick a project to let them read it, and more switches appear here.</p>
        </div>
        <div id="launch-access"></div>
        ${projects.length ? accessTemplate(state) : ""}
      </div>
    </div>
    <footer>
      <button class="start" id="launch-start" type="button">Start swarm</button>
      <div><p>${limits.maxAgents} agents · up to ${limits.maxTurns} turns · about ${limits.wallClockMs / 60_000} min · balanced models</p><p class="models">${esc(models)}</p></div>
      <p class="mode" id="launch-mode">Chat mode · nothing on disk</p>
    </footer>
  </form>
</main><script>${PAGE_SCRIPT}</script>`;
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

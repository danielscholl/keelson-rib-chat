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
  PLAN_NAME,
  POWER_MODELS,
  pinnedModels,
  SIZE_PRESETS,
  SWARM_POWERS,
  SWARM_SIZES,
  type SwarmPower,
  type SwarmSize,
  type SwarmSummary,
} from "../types.ts";
import { TRACKER_TOOLS, WORKFLOW } from "./actions.ts";
import { day, hhmm, plural } from "./format.ts";
import { esc } from "./record.ts";

type ActionsSection = Extract<CanvasBoardView["sections"][number], { kind: "actions" }>;
type Item = ActionsSection["items"][number];
type Field = NonNullable<Item["fields"]>[number];

export interface LaunchState {
  projects: readonly { id: string; name: string; rootPath: string }[];
  hasSwarms?: boolean;
  canCreateProject?: boolean;
  canInitTracker?: boolean;
  provider?: string;
  classes?: readonly { provider: string; defaultModel?: string; classes?: ModelClassMap }[];
  toolReachability?: readonly ToolReachability[];
  toolReachabilityError?: string;
  refused?: readonly string[];
  dispatchBlocked?: string;
}

export { TRACKER_TOOLS };

export const TASK_PLACEHOLDER =
  "What should the swarm work out? A question, a pasted issue, or a GitHub issue or PR link.";

export const COMPACT_PLACEHOLDER = "Describe a problem. Agents work it out together.";

export function modelField(model?: string, provider?: string): Field {
  return {
    name: "model",
    label: "Model",
    placeholder: "the plan's models",
    half: true,
    ...(model ? { defaultValue: model } : {}),
    modelPicker: { providerField: "provider", ...(provider ? { providerDefault: provider } : {}) },
  };
}

const PLANS = [
  {
    name: PLAN_NAME.small,
    blurb: "A narrow question, or a first pass before a bigger run.",
    size: "small",
    power: "fast",
  },
  {
    name: PLAN_NAME.medium,
    blurb: "Most tasks: investigate, debate, and decide.",
    size: "medium",
    power: "balanced",
  },
  {
    name: PLAN_NAME.large,
    blurb: "Wide or hard problems that are worth the spend.",
    size: "large",
    power: "deep",
  },
] as const satisfies readonly {
  name: string;
  blurb: string;
  size: SwarmSize;
  power: SwarmPower;
}[];

function planModels(
  state: LaunchState,
  power: SwarmPower,
): { lead: string; worker: string; pinned: boolean } | undefined {
  const pins = pinnedModels(state.provider, power);
  if (pins) return { ...pins, pinned: true };
  const provider = state.classes?.find((c) => c.provider === state.provider);
  const model = provider?.classes?.[power] ?? provider?.defaultModel;
  const label = `${state.provider}: ${model}`;
  return model ? { lead: label, worker: label, pinned: false } : undefined;
}

// The script redraws these cells when a picked model replaces the selected plan's pair.
function modelCells(pair: { lead: string; worker: string }): string {
  const cells: [string, string][] = [
    ["Lead", pair.lead],
    ["Workers", pair.worker],
  ];
  return cells
    .map(
      ([role, model]) =>
        `<span class="role">${role}</span><span class="model">${esc(model)}</span>`,
    )
    .join("");
}

function budgetSummary(size: SwarmSize): string {
  const l = SIZE_PRESETS[size];
  return `${l.maxAgents} agents for up to ${l.wallClockMs / 60_000} min`;
}

const PAGE_CSS = `
:root { --button-ink: var(--bg); }
:root[data-theme="light"] { --button-ink: var(--card); }
body { font-size: 14px; }
* { box-sizing: border-box; }
main { margin: 0; background: var(--card); }
header { display: flex; align-items: center; gap: 14px; padding: 24px; flex-wrap: wrap; }
.compact { display: flex; align-items: center; gap: 12px; padding: 16px; }
.compact input { flex: 1; min-width: 0; width: auto; }
.compact input::placeholder { color: var(--muted); opacity: 1; }
.compact .start, .more { flex: none; white-space: nowrap; }
.more { padding: 6px 0; border: 0; background: transparent; color: var(--fg); }
.intro { flex: 1; min-width: 220px; }
h1 { font-size: 22px; line-height: 1.3; margin: 0 0 5px; color: var(--fg-strong); }
p { margin: 0; }
.hint { color: var(--muted); font-size: 13px; }
button, textarea, select, input { font: inherit; }
button { cursor: pointer; border: 1px solid var(--border); border-radius: 8px; padding: 10px 16px; }
.fields { padding: 0 24px 24px; }
label { display: block; font-size: 12px; font-weight: 600; letter-spacing: .08em; margin-bottom: 8px; }
textarea, select, input { display: block; width: 100%; border: 1px solid var(--border);
  border-radius: 8px; padding: 12px; color: var(--fg); background: var(--bg); }
textarea { resize: vertical; min-height: 112px; line-height: 1.5; }
textarea::placeholder { color: var(--muted); opacity: 1; }
.task-hint { margin-top: 8px; }
.task-hint:empty { display: none; }
.plans { margin-top: 24px; }
.plans-heading { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.eyebrow { font-size: 12px; font-weight: 600; letter-spacing: .08em; }
.chip { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.plan[aria-pressed="true"] .chip { color: var(--accent); }
.chevron { display: inline-block; margin-left: 6px; }
.plan-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.plan { display: flex; flex-direction: column; justify-content: flex-start; text-align: left; padding: 16px; background: var(--bg); color: var(--fg); }
.plan[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.plan-title { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600; color: var(--fg-strong); }
.plan-blurb { display: block; margin-top: 8px; color: var(--muted); line-height: 1.5; min-height: 4.5em; }
.plan-body { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 16px; margin-top: 16px; }
.figures { display: flex; gap: 14px; flex: none; }
.figure { color: var(--muted); font-size: 12px; }
.figure strong { display: block; font-size: 24px; line-height: 1.3; font-weight: 600; color: var(--fg-strong); }
.plan-models { flex: 1; min-width: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 8px;
  align-items: baseline; border-left: 1px solid var(--border); padding-left: 14px; }
.plan-models .role { font-family: var(--sans); font-size: 12px; color: var(--muted); }
.plan-models .model { color: var(--fg); overflow-wrap: anywhere; }
.plan-models .model.is-picked { color: var(--accent); font-weight: 600; }
.pickers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 24px; }
.detail { margin-top: 10px; line-height: 1.5; }
.other-model { margin-top: 12px; }
.project-note { margin-top: 10px; }
.project-note:empty { display: none; }
.new-project { margin-top: 16px; display: grid; gap: 12px; }
.access { margin-top: 24px; }
.access-heading { font-size: 12px; letter-spacing: .08em; margin: 0 0 8px; }
.access-row { display: grid; grid-template-columns: 44px minmax(150px, 1fr) minmax(240px, 2fr);
  gap: 14px; align-items: center; padding: 16px 0; border-top: 1px solid var(--border); }
.access-name { color: var(--fg-strong); font-weight: 600; }
.access-meaning { color: var(--muted); line-height: 1.5; }
.switch { width: 44px; height: 26px; padding: 3px; border-radius: 999px; background: var(--card-2); }
.switch::after { content: ""; display: block; width: 18px; height: 18px; border-radius: 50%; background: var(--muted); }
.switch[aria-checked="true"] { background: var(--accent); border-color: var(--accent); }
.switch[aria-checked="true"]::after { background: var(--button-ink); transform: translateX(18px); }
.switch:disabled { cursor: not-allowed; }
.access-details { grid-column: 3; min-width: 0; }
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
footer { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 0 24px 24px; }
.start { background: var(--accent); color: var(--button-ink); border-color: var(--accent); font-weight: 600; }
.start:disabled { cursor: wait; }
.models { font-family: var(--mono); color: var(--muted); font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
.summary { flex: 1; min-width: 0; color: var(--muted); overflow-wrap: anywhere; }
button:focus-visible, textarea:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
[hidden] { display: none !important; }
@media (max-width: 900px) {
  .compact { flex-wrap: wrap; }
  .compact input { flex-basis: calc(100% - 180px); }
}
@media (max-width: 640px) {
  header, footer { padding: 18px; }
  .fields { padding: 0 18px 18px; }
  .pickers { grid-template-columns: 1fr; }
  .access-row { grid-template-columns: 44px minmax(0, 1fr); gap: 12px; }
  .access-meaning, .access-details { grid-column: 2; }
  .plan-cards { grid-template-columns: 1fr; }
  .plan-blurb { min-height: 0; }
}
`;

const PAGE_SCRIPT = `
(() => {
  let busy = false;
  let modelBlocked = false;
  let dirty = false;
  let dispatched = false;
  let ready = false;
  let pending;
  let capture;
  let restoreDraft;
  let activeStart;
  let startLabel;
  let collapse;
  let refreshLinks = () => {};
  const validDraft = (state) => state && state.version === 1
    && typeof state.task === "string" && typeof state.expanded === "boolean"
    && typeof state.customize === "boolean"
    && ["small", "medium", "large"].includes(state.size)
    && ["fast", "balanced", "deep"].includes(state.power)
    && typeof state.project === "string"
    && (state.name === undefined || typeof state.name === "string")
    && (state.rootPath === undefined || typeof state.rootPath === "string")
    && (state.projectRoot === undefined || typeof state.projectRoot === "string")
    && state.permissions && ["write", "workflows", "tracker"].every((key) =>
      typeof state.permissions[key] === "boolean")
    && Array.isArray(state.workflows) && state.workflows.length <= ${START_BOUNDS.maxWorkflows}
    && state.workflows.every((name) => typeof name === "string" && ${WORKFLOW}.test(name))
    && new Set(state.workflows).size === state.workflows.length
    && typeof state.workflowEntry === "string" && typeof state.otherModel === "string"
    && typeof state.modelProvider === "string"
    && (state.modelSelection === "" || state.modelSelection === "other"
      || (state.modelSelection && typeof state.modelSelection.model === "string"
        && Boolean(state.modelSelection.model)
        && typeof state.modelSelection.provider === "string"))
    && (state.workerSelection === undefined || state.workerSelection === ""
      || (state.workerSelection && typeof state.workerSelection.model === "string"
        && Boolean(state.workerSelection.model)
        && typeof state.workerSelection.provider === "string"));
  keelson.onRestore?.((state) => {
    if (dirty || dispatched || !validDraft(state)) return;
    if (ready) restoreDraft(state);
    else pending = state;
  });
  const saveEdit = () => {
    dirty = true;
    keelson.saveState?.(capture());
  };
  const watchText = (field, update = () => {}) => {
    ["input", "change"].forEach((event) => field.addEventListener(event, () => {
      update();
      saveEdit();
    }));
  };
  const finishInitialization = () => {
    ready = true;
    if (pending) restoreDraft(pending);
    pending = undefined;
  };
  const updateStart = () => {
    activeStart.disabled = busy || modelBlocked;
    activeStart.textContent = busy ? "Starting…" : startLabel;
    if (busy) activeStart.setAttribute("aria-busy", "true");
    else activeStart.removeAttribute("aria-busy");
  };
  const dispatch = (payload) => {
    if (busy) return;
    dispatched = true;
    keelson.saveState?.({});
    keelson.action("start-swarm", payload);
    busy = true;
    updateStart();
    setTimeout(() => {
      busy = false;
      updateStart();
    }, 2000);
  };
  const initializeExpanded = () => {
  const form = document.getElementById("launch-form");
  const task = document.getElementById("launch-task");
  const project = document.getElementById("launch-project");
  const newFields = document.getElementById("new-project-fields");
  const name = document.getElementById("launch-project-name");
  const folder = document.getElementById("launch-project-folder");
  const nameError = document.getElementById("project-name-error");
  const isNew = () => project.value === "new" && form.dataset.canCreateProject === "true";
  const start = document.getElementById("launch-start");
  activeStart = start;
  startLabel = "Start swarm";
  updateStart();
  const note = document.getElementById("project-note");
  const row = document.getElementById("project-row");
  const mode = document.getElementById("launch-mode");
  const chatNote = note.textContent;
  const chatMode = mode.textContent;
  const taskHint = document.getElementById("task-hint");
  const updateLinks = () => {
    const found = [];
    const github = /https:\\/\\/github\\.com\\/([\\w.-]+\\/[\\w.-]+)\\/(issues|pull)\\/(\\d+)[^\\s]*/g;
    let match;
    while ((match = github.exec(task.value))) {
      found.push((match[2] === "pull" ? "PR" : "issue") + " #" + match[3] + " from " + match[1]);
    }
    const other = /https?:\\/\\/\\S+|(^|[\\s(])#\\d+\\b/.test(task.value.replace(github, ""));
    taskHint.textContent = other
      ? "Agents can't open other links. Paste their text instead."
      : found.length ? "Will attach " + found.join(", ") + "." : "";
  };
  const access = document.getElementById("launch-access");
  const template = document.getElementById("access-template");
  const permissions = { write: false, workflows: false, tracker: false };
  let workflows = [];
  let controls;
  let mountedProject = "";
  const updateMode = () => {
    mode.textContent = project.value
      ? (isNew() ? "creating " + (name.value.trim() || "<name>")
        : "reading " + project.selectedOptions[0].dataset.name
          + (permissions.write ? " and writing on a branch" : ""))
        + (permissions.workflows && workflows.length ? ", then " + workflows.join(", ") : "")
        + (permissions.tracker ? ", with beads" : "")
      : chatMode;
  };
  const workflowError = (message) => {
    controls.error.textContent = message;
    controls.error.hidden = !message;
    controls.entry.setAttribute("aria-invalid", message ? "true" : "false");
  };
  let removeButtons = [];
  const renderWorkflows = () => {
    controls.chips.replaceChildren();
    removeButtons = [];
    workflows.forEach((name, index) => {
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
        saveEdit();
        (removeButtons[Math.min(index, removeButtons.length - 1)] ?? controls.entry).focus();
      });
      removeButtons.push(remove);
      chip.append(label, remove);
      controls.chips.append(chip);
    });
    controls.count.textContent = workflows.length + " / ${START_BOUNDS.maxWorkflows} workflows";
    updateMode();
  };
  const addWorkflows = (save = true) => {
    const names = controls.entry.value.trim().split(/[\\s,]+/).filter(Boolean);
    const bad = names.find((name) => !${WORKFLOW}.test(name));
    if (bad) {
      workflowError("'" + bad + "' is not a workflow name. Use letters, digits, '.', '_' or '-', and separate names with spaces or commas.");
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
    if (save) saveEdit();
    return true;
  };
  const sizes = ["small", "medium", "large"];
  const cards = sizes.map((size) => document.getElementById("plan-" + size));
  const modelSelect = document.getElementById("launch-model");
  const otherModel = document.getElementById("launch-other-model");
  const workerSelect = document.getElementById("launch-worker-model");
  // Without a pin the plan's workers follow whatever the lead runs.
  const planWorker = (card) => {
    const cells = document.getElementById("models-" + card.dataset.size);
    return cells && cells.dataset.pinned === "true" ? cells.dataset.worker : "";
  };
  const showModels = (card, lead, worker) => {
    const cells = document.getElementById("models-" + card.dataset.size);
    if (!cells) return;
    const keepsPin = cells.dataset.pinned === "true" && (!lead || provider === form.dataset.provider);
    const workers = worker || (lead && !keepsPin ? lead : "");
    const pairs = [["Lead", lead, cells.dataset.lead], ["Workers", workers, cells.dataset.worker]];
    cells.replaceChildren(...pairs.flatMap(([role, picked, plan]) => {
      const label = document.createElement("span");
      label.className = "role";
      label.textContent = role;
      const value = document.createElement("span");
      value.className = picked ? "model is-picked" : "model";
      value.textContent = picked || plan;
      return [label, value];
    }));
  };
  const budgets = JSON.parse(form.dataset.budgets);
  let size = "medium";
  let power = "balanced";
  let model = "";
  let provider = "";
  let worker = "";
  let workerProvider = "";
  let otherProvider = form.dataset.provider;
  const providers = JSON.parse(form.dataset.providers);
  const modelError = document.getElementById("model-error");
  const updateChoice = () => {
    const unavailable = [provider, workerProvider].find((p) => p && !providers.includes(p));
    const mixed = Boolean(model && worker && provider && workerProvider && provider !== workerProvider);
    modelBlocked = Boolean(unavailable) || mixed;
    modelError.textContent = unavailable
      ? "Provider " + unavailable + " is unavailable. Choose a model or plan again."
      : mixed ? "Lead and workers need models from the same provider." : "";
    modelError.hidden = !modelBlocked;
    updateStart();
    cards.forEach((card) => {
      const selected = size === card.dataset.size && power === card.dataset.power;
      card.setAttribute("aria-pressed", String(selected));
      document.getElementById("chip-" + card.dataset.size).hidden = !selected;
      showModels(card, selected ? model : "", selected ? worker : "");
    });
    document.getElementById("launch-summary").textContent = budgets[size];
    document.getElementById("launch-models").textContent = model && worker
      ? (model === worker ? " on " + model : " on " + model + " and " + worker)
      : model ? " with lead " + model : worker ? " with workers " + worker : "";
    document.getElementById("other-model-row").hidden = modelSelect.value !== "other";
  };
  cards.forEach((card) => card.addEventListener("click", () => {
    size = card.dataset.size;
    power = card.dataset.power;
    model = "";
    provider = "";
    worker = "";
    workerProvider = "";
    modelSelect.value = "";
    workerSelect.value = "";
    otherModel.value = "";
    otherProvider = form.dataset.provider;
    updateChoice();
    saveEdit();
  }));
  const updateModel = () => {
    const choice = modelSelect.value === "other"
      ? { model: otherModel.value.trim(), provider: otherProvider }
      : modelSelect.value ? JSON.parse(modelSelect.value) : { model: "", provider: "" };
    model = choice.model;
    provider = model ? choice.provider : "";
    updateChoice();
  };
  watchText(modelSelect, () => {
    otherProvider = form.dataset.provider;
    updateModel();
  });
  watchText(otherModel, updateModel);
  const updateWorker = () => {
    const choice = workerSelect.value ? JSON.parse(workerSelect.value) : { model: "", provider: "" };
    worker = choice.model;
    workerProvider = worker ? choice.provider : "";
    updateChoice();
  };
  watchText(workerSelect, updateWorker);
  updateChoice();
  document.getElementById("launch-fewer")?.addEventListener("click", () => collapse?.());
  const renderPermissions = () => {
    Object.keys(permissions).forEach((key) => {
      const button = document.getElementById("allow-" + key);
      permissions[key] = key === "write" && isNew()
        ? true : permissions[key] && !button.disabled;
      button.setAttribute("aria-checked", String(permissions[key]));
      document.getElementById(key + "-row").classList.toggle("is-on", permissions[key]);
      if (key !== "write") document.getElementById(key + "-details").hidden = !permissions[key];
    });
    updateMode();
  };
  const mountProject = () => {
    mountedProject = project.value;
    const selected = project.selectedOptions[0];
    const hasProject = Boolean(project.value);
    const creating = isNew();
    if (newFields) newFields.hidden = !creating;
    row.classList.toggle("has-project", hasProject);
    note.textContent = creating ? "Write is on. Agents write in branch-isolated worktrees; a new repository without origin uses local writing." : hasProject
      ? "Agents read " + selected.dataset.path + " and run read-only commands there. Nothing changes unless you allow more."
      : chatNote;
    Object.keys(permissions).forEach((key) => { permissions[key] = false; });
    workflows = [];
    controls = undefined;
    access.replaceChildren();
    if (hasProject && template) {
      access.append(template.content.cloneNode(true));
      if (creating) {
        permissions.write = true;
        document.getElementById("allow-write").disabled = true;
        document.getElementById("write-meaning").textContent = "Write stays on for creation. Writers use their own branches and worktrees, with local writing when there is no origin.";
        const canInitTracker = form.dataset.canInitTracker === "true";
        permissions.tracker = canInitTracker;
        const trackerAvailable = access.querySelectorAll('[data-tool][data-reachable="true"]').length > 0;
        document.getElementById("tracker-row").hidden = !canInitTracker && !trackerAvailable;
        document.getElementById("allow-tracker").disabled = !canInitTracker;
        document.getElementById("tracker-meaning").textContent = canInitTracker
          ? "Initialize the project's beads tracker before starting the swarm. If initialization fails, it starts without tracker tools. No grants are created."
          : "no tracker yet in a new project";
      }
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
          renderPermissions();
          saveEdit();
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
        const text = event.clipboardData.getData("text").replace(/[\\r\\n]+/g, " ");
        const from = controls.entry.selectionStart;
        const to = controls.entry.selectionEnd;
        controls.entry.value = controls.entry.value.slice(0, from) + text + controls.entry.value.slice(to);
        addWorkflows(false);
        saveEdit();
      });
      watchText(controls.entry);
      renderPermissions();
      renderWorkflows();
    }
    updateMode();
  };
  watchText(project, () => {
    if (project.value !== mountedProject) mountProject();
  });
  refreshLinks = updateLinks;
  watchText(task, updateLinks);
  if (name) watchText(name, () => {
    if (name.value.trim()) {
      nameError.hidden = true;
      name.setAttribute("aria-invalid", "false");
    }
    updateMode();
  });
  if (folder) watchText(folder);
  capture = () => ({
    version: 1, task: task.value, expanded: true, customize: false,
    size, power, project: project.value, permissions: { ...permissions },
    ...(name ? { name: name.value, rootPath: folder.value } : {}),
    projectRoot: project.value && !isNew() ? project.selectedOptions[0].dataset.root : "",
    workflows: [...workflows], workflowEntry: controls?.entry.value ?? "",
    modelSelection: modelSelect.value === "other" ? "other"
      : model ? { model, provider } : "",
    workerSelection: worker ? { model: worker, provider: workerProvider } : "",
    otherModel: otherModel.value, modelProvider: otherProvider
  });
  restoreDraft = (state) => {
    task.value = state.task;
    updateLinks();
    if (name) name.value = state.name ?? "";
    if (folder) folder.value = state.rootPath ?? "";
    size = state.size;
    power = state.power;
    otherModel.value = state.otherModel;
    otherProvider = state.modelProvider;
    if (state.modelSelection && state.modelSelection !== "other") {
      const value = JSON.stringify(state.modelSelection);
      if (!Array.from(modelSelect.options).some((option) => option.value === value)) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = state.modelSelection.model + " · " + state.modelSelection.provider;
        modelSelect.append(option);
      }
      modelSelect.value = value;
    } else modelSelect.value = state.modelSelection;
    if (state.workerSelection) {
      const value = JSON.stringify(state.workerSelection);
      if (!Array.from(workerSelect.options).some((option) => option.value === value)) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = state.workerSelection.model + " · " + state.workerSelection.provider;
        workerSelect.append(option);
      }
      workerSelect.value = value;
    } else workerSelect.value = "";
    updateWorker();
    updateModel();
    project.value = (state.project !== "new" || form.dataset.canCreateProject === "true")
      && Array.from(project.options).some((option) => option.value === state.project)
      ? state.project : "";
    mountProject();
    const sameScope = isNew()
      || (project.value && state.projectRoot === project.selectedOptions[0].dataset.root);
    if (controls && sameScope) {
      Object.keys(permissions).forEach((key) => { permissions[key] = state.permissions[key]; });
      workflows = [...state.workflows];
      controls.entry.value = state.workflowEntry;
      renderPermissions();
      renderWorkflows();
    }
    if (project.value !== state.project || (project.value && !sameScope)
      || (isNew() && state.permissions.tracker && !permissions.tracker)) {
      keelson.saveState?.(capture());
    }
  };
  // The host's frame sandbox grants allow-scripts only, never allow-forms, so a
  // form never fires submit here; Start is a plain click.
  const startSwarm = () => {
    if (busy || modelBlocked) return;
    if (isNew() && !name.value.trim()) {
      nameError.textContent = "A new project needs a name.";
      nameError.hidden = false;
      name.setAttribute("aria-invalid", "true");
      name.focus();
      return;
    }
    if (permissions.workflows && !addWorkflows(false)) return;
    const payload = {
      nonce: form.dataset.nonce,
      task: task.value,
      project: project.value,
      tools: project.value ? (permissions.write ? "write" : "read") : "none"
    };
    if (isNew()) {
      payload.name = name.value.trim();
      payload.tracker = permissions.tracker;
      if (folder.value.trim()) payload.rootPath = folder.value.trim();
    }
    if (permissions.workflows && workflows.length) payload.workflows = workflows.join(", ");
    if (permissions.tracker) {
      const names = Array.from(access.querySelectorAll('[data-tool][data-reachable="true"]'))
        .map((chip) => chip.dataset.tool);
      if (names.length) payload.lead_tools = names;
    }
    if (model) {
      payload.size = size;
      payload.model = model;
      if (provider) payload.provider = provider;
      const workers = worker
        || (provider === form.dataset.provider ? planWorker(cards.find((card) => card.dataset.size === size)) : "");
      if (workers) payload.worker_model = workers;
    } else if (worker) {
      payload.size = size;
      payload.power = power;
      payload.worker_model = worker;
      if (workerProvider) payload.provider = workerProvider;
    } else if (size !== "medium" || power !== "balanced") {
      payload.size = size;
      if (power !== "balanced") payload.power = power;
    }
    dispatch(payload);
  };
  start.addEventListener("click", startSwarm);
  [task, name, folder].filter(Boolean).forEach((field) => field.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229
      && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      startSwarm();
    }
  }));
  };
  if (!document.getElementById("launch-compact")) {
    initializeExpanded();
    finishInitialization();
    return;
  }
  let expanded = false;
  const initializeCompact = () => {
  const compact = document.getElementById("launch-compact");
  const task = document.getElementById("compact-task");
  activeStart = document.getElementById("compact-start");
  startLabel = "Start";
  updateStart();
  watchText(task);
  capture = () => ({
    version: 1, task: task.value, expanded: false, customize: false,
    size: "medium", power: "balanced", project: "", projectRoot: "",
    permissions: { write: false, workflows: false, tracker: false },
    workflows: [], workflowEntry: "", modelSelection: "", workerSelection: "", otherModel: "",
    modelProvider: ""
  });
  const startCompact = () => dispatch({
    nonce: compact.dataset.nonce,
    task: task.value,
    project: "",
    tools: "none"
  });
  activeStart.addEventListener("click", startCompact);
  task.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      startCompact();
    }
  });
  const expand = (focus = false) => {
    if (expanded) return;
    expanded = true;
    const draft = task.value;
    const template = document.getElementById("launch-expanded");
    document.getElementById("launch-root").replaceChildren(template.content.cloneNode(true));
    initializeExpanded();
    const textarea = document.getElementById("launch-task");
    textarea.value = draft;
    refreshLinks();
    if (focus) textarea.focus();
  };
  restoreDraft = (state) => {
    if (state.expanded || /[\\r\\n]/.test(state.task) || state.customize
      || state.size !== "medium" || state.power !== "balanced" || state.project
      || state.modelSelection || state.workerSelection || state.otherModel || state.workflows.length
      || state.workflowEntry || Object.values(state.permissions).some(Boolean)) {
      expand();
      restoreDraft(state);
    } else task.value = state.task;
  };
  const expandFromClick = () => {
    if (expanded) return;
    expand(true);
    saveEdit();
  };
  document.getElementById("compact-more").addEventListener("click", expandFromClick);
  };
  // Fewer options keeps the task's first line and drops every other choice,
  // since the compact row only starts the default plan.
  collapse = () => {
    if (!expanded) return;
    const draft = document.getElementById("launch-task").value.split(/[\\r\\n]/)[0];
    expanded = false;
    const template = document.getElementById("launch-compact-template");
    document.getElementById("launch-root").replaceChildren(template.content.cloneNode(true));
    initializeCompact();
    const input = document.getElementById("compact-task");
    input.value = draft;
    saveEdit();
    input.focus();
  };
  initializeCompact();
  finishInitialization();
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
  const trackerMeaning =
    state.toolReachabilityError ??
    (state.toolReachability
      ? "The lead reads and updates beads for the project, and says in the channel what it changed."
      : "This host does not say which tools a lead may hold.");
  const rows = [
    {
      key: "write",
      name: "Write",
      meaning: "Change files. Each agent works in its own worktree on a branch, never on main.",
      disabled: false,
      details: "",
    },
    {
      key: "workflows",
      name: "Run workflows",
      meaning: workflowMeaning,
      disabled: Boolean(state.dispatchBlocked),
      details: `<div class="access-details" id="workflows-details" hidden><div class="chips" id="workflow-chips"></div><input class="workflow-input" id="workflow-entry" type="text" aria-label="Add a workflow" aria-describedby="workflow-count workflow-error" placeholder="add a workflow…" /><p class="workflow-error" id="workflow-error" role="alert" hidden></p><p class="hint workflow-count" id="workflow-count">0 / ${START_BOUNDS.maxWorkflows} workflows</p></div>`,
    },
    {
      key: "tracker",
      name: "Use the tracker",
      meaning: trackerMeaning,
      disabled: !state.toolReachability || Boolean(state.toolReachabilityError),
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
        `<div class="access-row" id="${item.key}-row"><button class="switch" id="allow-${item.key}" type="button" role="switch" aria-label="${esc(item.name)}" aria-describedby="${item.key}-meaning" aria-checked="false"${item.disabled ? " disabled" : ""}></button><div class="access-name">${esc(item.name)}</div><p class="access-meaning" id="${item.key}-meaning">${esc(item.meaning)}</p>${item.details}</div>`,
    )
    .join("")}</section></template>`;
}

export function buildLaunch(state: LaunchState, nonce: string, generation = 0): string {
  const projects = state.projects.filter((p) => p.name !== DEFAULT_PROJECT_NAME);
  const models = Object.fromEntries(SWARM_POWERS.map((p) => [p, planModels(state, p)]));
  const budgets = Object.fromEntries(SWARM_SIZES.map((s) => [s, budgetSummary(s)]));
  const cards = PLANS.map((plan) => {
    const l = SIZE_PRESETS[plan.size];
    const pair = models[plan.power];
    const selected = plan.size === "medium";
    return `<button class="plan" id="plan-${plan.size}" type="button" data-size="${plan.size}" data-power="${plan.power}" aria-pressed="${selected}">
      <span class="plan-title">${plan.name}<span class="chip" id="chip-${plan.size}"${selected ? "" : " hidden"}>selected</span></span>
      <span class="plan-blurb">${plan.blurb}</span>
      <span class="plan-body"><span class="figures"><span class="figure"><strong>${l.maxAgents}</strong>agents</span><span class="figure"><strong>${l.maxTurns}</strong>turns</span><span class="figure"><strong>${l.wallClockMs / 60_000}</strong>min</span></span>${pair ? `<span class="models plan-models" id="models-${plan.size}" data-lead="${esc(pair.lead)}" data-worker="${esc(pair.worker)}" data-pinned="${pair.pinned}">${modelCells(pair)}</span>` : ""}</span>
    </button>`;
  }).join("");
  const catalog = [...(state.classes ?? [])];
  if (state.provider && !catalog.some((c) => c.provider === state.provider)) {
    catalog.push({ provider: state.provider });
  }
  const modelOptions = catalog
    .map((c) => {
      const names = new Set([
        ...(c.defaultModel ? [c.defaultModel] : []),
        ...Object.values(c.classes ?? {}),
        ...Object.values(POWER_MODELS[c.provider] ?? {}).flatMap((p) => [p.lead, p.worker]),
      ]);
      if (names.size === 0) return "";
      return `<optgroup label="${esc(c.provider)}">${[...names]
        .map(
          (model) =>
            `<option value="${esc(JSON.stringify({ model, provider: c.provider }))}">${esc(model)}</option>`,
        )
        .join("")}</optgroup>`;
    })
    .join("");
  const options = projects
    .map((p) => {
      const path = projectPath(p.rootPath);
      return `<option value="${esc(p.id)}" data-name="${esc(p.name)}" data-path="${esc(path)}" data-root="${esc(p.rootPath)}">${esc(`${p.name} · ${path}`)}</option>`;
    })
    .join("");
  const expanded = `
  <header>
    <div class="intro"><h1>New swarm</h1><p class="hint">Agents investigate, debate, and bring back a conclusion.</p></div>
    ${state.hasSwarms ? '<button class="more" id="launch-fewer" type="button" aria-controls="launch-root">Fewer options<span class="chevron" aria-hidden="true">⌃</span></button>' : ""}
  </header>
  <form id="launch-form" data-nonce="${esc(nonce)}" data-can-create-project="${Boolean(state.canCreateProject)}" data-can-init-tracker="${Boolean(state.canInitTracker)}" data-provider="${esc(state.provider ?? "")}" data-providers="${esc(JSON.stringify(catalog.map((c) => c.provider)))}" data-budgets="${esc(JSON.stringify(budgets))}">
    <div class="fields">
      <label for="launch-task">TASK</label>
      <textarea id="launch-task" name="task" rows="4" required aria-describedby="task-hint" placeholder="${esc(TASK_PLACEHOLDER)}"></textarea>
      <p class="hint task-hint" id="task-hint" aria-live="polite"></p>
      <section class="plans" aria-labelledby="plans-heading">
        <div class="plans-heading"><span class="eyebrow" id="plans-heading">SIZE</span></div>
        <div class="plan-cards">${cards}</div>
      </section>
      <div class="pickers">
          <div><label for="launch-model">LEAD MODEL</label><select id="launch-model" name="model"><option value="" selected>the plan's lead</option>${modelOptions}<option value="other">Other…</option></select><div class="other-model" id="other-model-row" hidden><label for="launch-other-model">Model name</label><input id="launch-other-model" type="text" autocomplete="off"></div><p class="hint detail" id="model-error" role="alert" hidden></p></div>
          <div><label for="launch-worker-model">WORKERS MODEL</label><select id="launch-worker-model" name="worker_model"><option value="" selected>the plan's workers</option>${modelOptions}</select></div>
          <div class="project-row" id="project-row"><label for="launch-project">PROJECT</label><select id="launch-project" name="project" aria-describedby="project-note">
            <option value="" selected>No project · chat only</option>${options}${state.canCreateProject ? '<option value="new">New project…</option>' : ""}
          </select></div>
      </div>
      <div class="project">
        <p class="hint project-note" id="project-note"></p>
        ${
          state.canCreateProject
            ? `<div class="new-project" id="new-project-fields" hidden>
          <div><label for="launch-project-name">Name</label><input id="launch-project-name" type="text" required autocomplete="off" aria-describedby="project-name-error new-project-hint"><p class="hint detail" id="project-name-error" role="alert" hidden></p></div>
          <div><label for="launch-project-folder">Folder (optional)</label><input id="launch-project-folder" type="text" autocomplete="off" placeholder="${esc("~/keelson/<name>")}" aria-describedby="new-project-hint"></div>
          <p class="hint" id="new-project-hint">Keelson creates the folder, runs git init with a first empty commit, and registers it as a project. Write stays on; without origin, writers work locally. An existing repository supplied as Folder is registered untouched and keeps its remote or local write mode.</p>
        </div>`
            : ""
        }
        <div id="launch-access"></div>
      </div>
    </div>
    <footer>
      <button class="start" id="launch-start" type="button">Start swarm</button>
      <p class="summary" aria-live="polite"><span id="launch-summary">${budgets.medium}</span><span id="launch-models"></span>, <span id="launch-mode">chat only</span>.</p>
    </footer>
  </form>`;
  const compact = `<div class="compact" id="launch-compact" data-nonce="${esc(nonce)}">
    <input id="compact-task" type="text" aria-label="Swarm task" placeholder="${esc(COMPACT_PLACEHOLDER)}">
    <button class="start" id="compact-start" type="button">Start</button>
    <button class="more" id="compact-more" type="button" aria-expanded="false" aria-controls="launch-root">Options</button>
  </div>`;
  return `<style>${designTokenCssBlock()}\n${PAGE_CSS}</style>
<main id="launch-root" data-generation="${generation}">${state.hasSwarms ? compact : expanded}</main>
${state.hasSwarms ? `<template id="launch-expanded">${expanded}</template><template id="launch-compact-template">${compact}</template>` : ""}
${projects.length || state.canCreateProject ? accessTemplate(state) : ""}<script>${PAGE_SCRIPT}</script>`;
}

// A swarm that did not finish offers Retry with a model picker, since the model
// is the usual cause. A finished one offers Go deeper: the same launch on the
// next plan up, with that plan's models.
export function runAgainItem(s: SwarmSummary, launch: StartSwarmInput): Item[] {
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
  ].join(", ");
  if (s.status !== "done") {
    return [
      {
        type: "run-again",
        label: "Retry",
        glyph: "↻",
        hint: `Starts a new swarm with ${reuses}. Context is not refreshed.`,
        fields: [{ ...modelField(s.model, s.provider), label: "Retry with" }],
        submitLabel: "Retry",
        binding: { id: s.id },
      },
    ];
  }
  const next = PLANS.find(
    (p) => SWARM_SIZES.indexOf(p.size) === SWARM_SIZES.indexOf(s.sizeBase) + 1,
  );
  if (!next) return [];
  return [
    {
      type: "run-again",
      label: "Go deeper",
      glyph: "›",
      hint: `Starts a ${next.name} with ${reuses}. Context is not refreshed.`,
      payload: { id: s.id, size: next.size, power: next.power },
    },
  ];
}

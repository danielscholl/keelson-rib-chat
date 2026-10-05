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
  POWER_MODELS,
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
  hasSwarms?: boolean;
  provider?: string;
  classes?: readonly { provider: string; defaultModel?: string; classes?: ModelClassMap }[];
  toolReachability?: readonly ToolReachability[];
  toolReachabilityError?: string;
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

// Each segment carries what the size costs, since the word alone does not.
export function sizeField(defaultValue: SwarmSize = "medium"): Field {
  return {
    name: "size",
    label: "Effort",
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
    name: "Quick look",
    blurb: "A narrow question, or a first pass before a bigger run.",
    size: "small",
    power: "fast",
  },
  {
    name: "Working session",
    blurb: "Most tasks: investigate, debate, and decide.",
    size: "medium",
    power: "balanced",
  },
  {
    name: "Deep dig",
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

function planModels(state: LaunchState, power: SwarmPower): string {
  const pins = pinnedModels(state.provider, power);
  if (pins) {
    return pins.lead === pins.worker
      ? `${pins.lead} · lead and workers`
      : `lead ${pins.lead} · workers ${pins.worker}`;
  }
  const provider = state.classes?.find((c) => c.provider === state.provider);
  const model = provider?.classes?.[power] ?? provider?.defaultModel;
  return model ? `${state.provider}: ${model}` : "";
}

function effortDetail(size: SwarmSize): string {
  const l = SIZE_PRESETS[size];
  return `${l.maxAgents} agents, ${l.maxConcurrent} at once · ${l.maxTurns} turns in all, ${l.maxTurnsPerAgent} per worker · stops after ${l.wallClockMs / 60_000} min`;
}

function budgetSummary(size: SwarmSize): string {
  const l = SIZE_PRESETS[size];
  return `${l.maxAgents} agents · up to ${l.maxTurns} turns · about ${l.wallClockMs / 60_000} min`;
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
.compact { display: flex; align-items: center; gap: 12px; padding: 16px; }
.compact h1 { margin: 0; font-size: 16px; white-space: nowrap; }
.compact input { flex: 1; min-width: 0; width: auto; }
.compact input::placeholder { color: var(--muted); opacity: 1; }
.compact-plan { background: var(--card-2); color: var(--fg); border-radius: 999px; }
.compact-budget { font: 12px var(--mono); color: var(--muted); }
.compact-plan, .compact-budget, .compact .start, .more { flex: none; white-space: nowrap; }
.more { padding: 6px 0; border: 0; background: transparent; color: var(--fg); }
.intro { flex: 1; min-width: 220px; }
h1 { font-size: 22px; line-height: 1.3; margin: 0 0 5px; color: var(--fg-strong); }
p { margin: 0; }
.hint { color: var(--muted); font-size: 13px; }
button, textarea, select, input { font: inherit; }
button { cursor: pointer; border: 1px solid var(--border); border-radius: 8px; padding: 10px 16px; }
.prepare { border-radius: 999px; color: var(--fg); background: var(--card-2); }
.fields { padding: 0 24px 24px; }
label { display: block; font-size: 12px; font-weight: 600; letter-spacing: .08em; margin-bottom: 8px; }
textarea, select, input { display: block; width: 100%; border: 1px solid var(--border);
  border-radius: 8px; padding: 12px; color: var(--fg); background: var(--bg); }
textarea { resize: vertical; min-height: 112px; line-height: 1.5; }
textarea::placeholder { color: var(--muted); opacity: 1; }
.task-hint { margin-top: 8px; }
.plans { margin-top: 24px; }
.plans-heading { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.eyebrow { font-size: 12px; font-weight: 600; letter-spacing: .08em; }
.chip { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.plan[aria-pressed="true"] .chip { color: var(--accent); }
.customize { margin-left: auto; padding: 6px 0 6px 12px; border: 0; color: var(--fg); background: transparent; }
.chevron { display: inline-block; margin-left: 6px; }
.customize[aria-expanded="true"] .chevron { transform: rotate(180deg); }
.plan-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.plan { text-align: left; padding: 16px; background: var(--bg); color: var(--fg); }
.plan[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.plan-title { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600; color: var(--fg-strong); }
.plan-blurb { display: block; margin-top: 8px; color: var(--muted); line-height: 1.5; min-height: 4.5em; }
.figures { display: flex; gap: 18px; margin-top: 16px; }
.figure { color: var(--muted); font-size: 12px; }
.figure strong { display: block; font-size: 24px; line-height: 1.3; font-weight: 600; color: var(--fg-strong); }
.plan-models { display: block; border-top: 1px solid var(--border); padding-top: 12px; margin-top: 14px; }
.drawer { margin-top: 16px; padding: 18px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--card-2); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; }
.effort-pills { display: flex; gap: 6px; }
.effort-pills button { flex: 1; padding: 10px; background: var(--bg); color: var(--fg); }
.effort-pills button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.detail { margin-top: 10px; line-height: 1.5; }
.other-model { margin-top: 12px; }
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
@media (max-width: 900px) {
  .compact { flex-wrap: wrap; }
  .compact input { flex-basis: calc(100% - 180px); }
}
@media (max-width: 640px) {
  header, footer { padding: 18px; }
  .fields { padding: 0 18px 18px; }
  .project-row { grid-template-columns: 1fr; }
  .prepare { width: 100%; }
  .mode { margin-left: 0; width: 100%; }
  .access-row { grid-template-columns: 8px 44px minmax(0, 1fr); gap: 12px; }
  .access-meaning, .access-details { grid-column: 3; }
  .plan-cards, .drawer { grid-template-columns: 1fr; }
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
  const validDraft = (state) => state && state.version === 1
    && typeof state.task === "string" && typeof state.expanded === "boolean"
    && typeof state.customize === "boolean"
    && ["small", "medium", "large"].includes(state.size)
    && ["fast", "balanced", "deep"].includes(state.power)
    && typeof state.project === "string"
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
        && typeof state.modelSelection.provider === "string"));
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
  const start = document.getElementById("launch-start");
  activeStart = start;
  startLabel = "Start swarm";
  updateStart();
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
  let mountedProject = "";
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
    if (save) saveEdit();
    return true;
  };
  const sizes = ["small", "medium", "large"];
  const cards = sizes.map((size) => document.getElementById("plan-" + size));
  const efforts = sizes.map((size) => document.getElementById("effort-" + size));
  const drawer = document.getElementById("launch-drawer");
  const customize = document.getElementById("launch-customize");
  const modelSelect = document.getElementById("launch-model");
  const otherModel = document.getElementById("launch-other-model");
  const models = JSON.parse(form.dataset.models);
  const details = JSON.parse(form.dataset.details);
  const budgets = JSON.parse(form.dataset.budgets);
  const categories = { fast: "quick models", balanced: "balanced models", deep: "strongest models" };
  let size = "medium";
  let power = "balanced";
  let model = "";
  let provider = "";
  let otherProvider = form.dataset.provider;
  const providers = JSON.parse(form.dataset.providers);
  const modelError = document.getElementById("model-error");
  const updateChoice = () => {
    modelBlocked = Boolean(model && provider && !providers.includes(provider));
    modelError.textContent = modelBlocked
      ? "Provider " + provider + " is unavailable. Choose a model or plan again."
      : "";
    modelError.hidden = !modelBlocked;
    updateStart();
    let matches = false;
    cards.forEach((card) => {
      const selected = !model && size === card.dataset.size && power === card.dataset.power;
      card.setAttribute("aria-pressed", String(selected));
      matches ||= selected;
    });
    efforts.forEach((effort) => effort.setAttribute("aria-pressed", String(size === effort.dataset.size)));
    document.getElementById("working-chip").textContent =
      !model && size === "medium" && power === "balanced" ? "selected" : "default";
    document.getElementById("custom-chip").hidden = matches;
    document.getElementById("effort-detail").textContent = details[size];
    document.getElementById("model-detail").textContent = model
      ? "Every agent runs " + model + ", lead and workers alike."
      : "Keeps the plan's pair: " + models[power] + ".";
    document.getElementById("launch-summary").textContent =
      budgets[size] + " · " + (model ? "one model" : categories[power]);
    document.getElementById("launch-models").textContent =
      model ? model + " · lead and workers" : models[power];
    document.getElementById("other-model-row").hidden = modelSelect.value !== "other";
  };
  cards.forEach((card) => card.addEventListener("click", () => {
    size = card.dataset.size;
    power = card.dataset.power;
    model = "";
    provider = "";
    modelSelect.value = "";
    otherModel.value = "";
    otherProvider = form.dataset.provider;
    updateChoice();
    saveEdit();
  }));
  efforts.forEach((effort) => effort.addEventListener("click", () => {
    size = effort.dataset.size;
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
  const renderDrawer = () => {
    customize.setAttribute("aria-expanded", String(!drawer.hidden));
    document.getElementById("customize-label").textContent = drawer.hidden ? "Customize" : "Hide";
  };
  customize.addEventListener("click", () => {
    drawer.hidden = !drawer.hidden;
    renderDrawer();
    saveEdit();
  });
  updateChoice();
  document.getElementById("launch-prepare").addEventListener("click", () => {
    keelson.action("start-in-chat", { nonce: form.dataset.nonce });
  });
  const renderPermissions = () => {
    Object.keys(permissions).forEach((key) => {
      const button = document.getElementById("allow-" + key);
      permissions[key] = permissions[key] && !button.disabled;
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
      renderWorkflows();
    }
    updateMode();
  };
  watchText(project, () => {
    if (project.value !== mountedProject) mountProject();
  });
  watchText(task);
  capture = () => ({
    version: 1, task: task.value, expanded: true, customize: !drawer.hidden,
    size, power, project: project.value, permissions: { ...permissions },
    workflows: [...workflows], workflowEntry: controls?.entry.value ?? "",
    modelSelection: modelSelect.value === "other" ? "other"
      : model ? { model, provider } : "",
    otherModel: otherModel.value, modelProvider: otherProvider
  });
  restoreDraft = (state) => {
    task.value = state.task;
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
    updateModel();
    drawer.hidden = !state.customize && !modelBlocked;
    renderDrawer();
    project.value = Array.from(project.options).some((option) => option.value === state.project)
      ? state.project : "";
    mountProject();
    if (controls) {
      Object.keys(permissions).forEach((key) => { permissions[key] = state.permissions[key]; });
      workflows = [...state.workflows];
      controls.entry.value = state.workflowEntry;
      renderPermissions();
      renderWorkflows();
    }
  };
  // The host's frame sandbox grants allow-scripts only, never allow-forms, so a
  // form never fires submit here; Start is a plain click.
  const startSwarm = () => {
    if (busy || modelBlocked) return;
    if (permissions.workflows && !addWorkflows(false)) return;
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
    if (model) {
      payload.size = size;
      payload.model = model;
      if (provider) payload.provider = provider;
    } else if (size !== "medium" || power !== "balanced") {
      payload.size = size;
      if (power !== "balanced") payload.power = power;
    }
    dispatch(payload);
  };
  start.addEventListener("click", startSwarm);
  task.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229
      && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      startSwarm();
    }
  });
  };
  const compact = document.getElementById("launch-compact");
  if (!compact) {
    initializeExpanded();
    finishInitialization();
    return;
  }
  const task = document.getElementById("compact-task");
  activeStart = document.getElementById("compact-start");
  startLabel = "Start";
  updateStart();
  watchText(task);
  capture = () => ({
    version: 1, task: task.value, expanded: false, customize: false,
    size: "medium", power: "balanced", project: "",
    permissions: { write: false, workflows: false, tracker: false },
    workflows: [], workflowEntry: "", modelSelection: "", otherModel: "", modelProvider: ""
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
  let expanded = false;
  const expand = (focus = false) => {
    if (expanded) return;
    expanded = true;
    const draft = task.value;
    const template = document.getElementById("launch-expanded");
    document.getElementById("launch-root").replaceChildren(template.content.cloneNode(true));
    initializeExpanded();
    const textarea = document.getElementById("launch-task");
    textarea.value = draft;
    if (focus) textarea.focus();
  };
  restoreDraft = (state) => {
    if (state.expanded || /[\\r\\n]/.test(state.task) || state.customize
      || state.size !== "medium" || state.power !== "balanced" || state.project
      || state.modelSelection || state.otherModel || state.workflows.length
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
  document.getElementById("compact-plan").addEventListener("click", expandFromClick);
  document.getElementById("compact-more").addEventListener("click", expandFromClick);
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
        `<div class="access-row" id="${item.key}-row"><span class="access-dot" aria-hidden="true"></span><button class="switch" id="allow-${item.key}" type="button" role="switch" aria-label="${esc(item.name)}" aria-describedby="${item.key}-meaning" aria-checked="false"${item.disabled ? " disabled" : ""}></button><div class="access-name">${esc(item.name)}<span class="access-tag">${esc(item.tag)}</span></div><p class="access-meaning" id="${item.key}-meaning">${esc(item.meaning)}</p>${item.details}</div>`,
    )
    .join("")}</section></template>`;
}

export function buildLaunch(state: LaunchState, nonce: string): string {
  const projects = state.projects.filter((p) => p.name !== DEFAULT_PROJECT_NAME);
  const models = Object.fromEntries(SWARM_POWERS.map((p) => [p, planModels(state, p)]));
  const details = Object.fromEntries(SWARM_SIZES.map((s) => [s, effortDetail(s)]));
  const budgets = Object.fromEntries(SWARM_SIZES.map((s) => [s, budgetSummary(s)]));
  const cards = PLANS.map((plan) => {
    const l = SIZE_PRESETS[plan.size];
    const selected = plan.size === "medium";
    return `<button class="plan" id="plan-${plan.size}" type="button" data-size="${plan.size}" data-power="${plan.power}" aria-pressed="${selected}">
      <span class="plan-title">${plan.name}${selected ? '<span class="chip" id="working-chip">selected</span>' : ""}</span>
      <span class="plan-blurb">${plan.blurb}</span>
      <span class="figures"><span class="figure"><strong>${l.maxAgents}</strong>agents</span><span class="figure"><strong>${l.maxTurns}</strong>turns</span><span class="figure"><strong>${l.wallClockMs / 60_000}</strong>min</span></span>
      <span class="models plan-models">${esc(models[plan.power]!)}</span>
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
      return `<option value="${esc(p.id)}" data-name="${esc(p.name)}" data-path="${esc(path)}">${esc(`${p.name} · ${path}`)}</option>`;
    })
    .join("");
  const expanded = `
  <header>
    <span class="glyph" aria-hidden="true">▶</span>
    <div class="intro"><h1>Start a swarm</h1><p class="hint">Describe the problem. Agents investigate, debate, and bring back a conclusion.</p></div>
    <button class="prepare" id="launch-prepare" type="button">Prepare in chat · attach an issue or PR</button>
  </header>
  <form id="launch-form" data-nonce="${esc(nonce)}" data-provider="${esc(state.provider ?? "")}" data-providers="${esc(JSON.stringify(catalog.map((c) => c.provider)))}" data-models="${esc(JSON.stringify(models))}" data-details="${esc(JSON.stringify(details))}" data-budgets="${esc(JSON.stringify(budgets))}">
    <div class="fields">
      <label for="launch-task">TASK</label>
      <textarea id="launch-task" name="task" rows="4" required aria-describedby="task-hint" placeholder="${esc(TASK_PLACEHOLDER)}"></textarea>
      <p class="hint task-hint" id="task-hint">Agents can't open links. Paste the text, or use Prepare in chat to attach the issue or PR.</p>
      <section class="plans" aria-labelledby="plans-heading">
        <div class="plans-heading"><span class="eyebrow" id="plans-heading">HOW HARD IT WORKS</span><span class="chip" id="custom-chip" hidden>custom</span><button class="customize" id="launch-customize" type="button" aria-expanded="false" aria-controls="launch-drawer"><span id="customize-label">Customize</span><span class="chevron" aria-hidden="true">⌄</span></button></div>
        <div class="plan-cards">${cards}</div>
        <div class="drawer" id="launch-drawer" hidden>
          <div><label id="effort-label">EFFORT</label><div class="effort-pills" role="group" aria-labelledby="effort-label">${SWARM_SIZES.map((s) => `<button id="effort-${s}" type="button" data-size="${s}" aria-pressed="${s === "medium"}">${s}</button>`).join("")}</div><p class="hint detail" id="effort-detail">${esc(details.medium!)}</p></div>
          <div><label for="launch-model">MODEL</label><select id="launch-model" name="model"><option value="" selected>the plan's models</option>${modelOptions}<option value="other">Other…</option></select><div class="other-model" id="other-model-row" hidden><label for="launch-other-model">Model name</label><input id="launch-other-model" type="text" autocomplete="off"></div><p class="hint detail" id="model-detail">Keeps the plan's pair: ${esc(models.balanced!)}.</p><p class="hint detail" id="model-error" role="alert" hidden></p></div>
        </div>
      </section>
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
      </div>
    </div>
    <footer>
      <button class="start" id="launch-start" type="button">Start swarm</button>
      <div aria-live="polite"><p id="launch-summary">${budgets.medium} · balanced models</p><p class="models" id="launch-models">${esc(models.balanced!)}</p></div>
      <p class="mode" id="launch-mode">Chat mode · nothing on disk</p>
    </footer>
  </form>`;
  const l = SIZE_PRESETS.medium;
  const compact = `<div class="compact" id="launch-compact" data-nonce="${esc(nonce)}">
    <span class="glyph" aria-hidden="true">▶</span><h1>New swarm</h1>
    <input id="compact-task" type="text" aria-label="Swarm task" placeholder="What should the swarm work out?">
    <button class="compact-plan" id="compact-plan" type="button" aria-expanded="false" aria-controls="launch-root">${PLANS[1].name}</button>
    <span class="compact-budget">${l.maxAgents} agents · ${l.wallClockMs / 60_000} min</span>
    <button class="start" id="compact-start" type="button">Start</button>
    <button class="more" id="compact-more" type="button" aria-expanded="false" aria-controls="launch-root">More options</button>
  </div>`;
  return `<style>${designTokenCssBlock()}\n${PAGE_CSS}</style>
<main id="launch-root">${state.hasSwarms ? compact : expanded}</main>
${state.hasSwarms ? `<template id="launch-expanded">${expanded}</template>` : ""}
${projects.length ? accessTemplate(state) : ""}<script>${PAGE_SCRIPT}</script>`;
}

// Run again reads the old swarm's size and model as its defaults, and its hint
// names what it reuses, so stale evidence is rerun on purpose.
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
    fields: [sizeField(s.sizeBase), modelField(s.model, s.provider)],
    submitLabel: "Run again",
    binding: { id: s.id },
  };
}

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
} from "@keelson/shared";
import type { StartSwarmInput } from "../tools.ts";
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
import { day, hhmm, plural } from "./format.ts";
import { esc } from "./record.ts";

type ActionsSection = Extract<CanvasBoardView["sections"][number], { kind: "actions" }>;
type Item = ActionsSection["items"][number];
type Field = NonNullable<Item["fields"]>[number];

export interface LaunchState {
  projects: readonly { id: string; name: string; rootPath: string }[];
  provider?: string;
  classes?: readonly { provider: string; defaultModel?: string; classes?: ModelClassMap }[];
}

export const TASK_PLACEHOLDER =
  "What should the swarm work out? Describe the issue or PR in words. A question works; so does a paste of the issue body.";

export function launchByline(): string {
  return "Agents investigate, debate, and bring back a conclusion.";
}

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
  .plan-cards, .drawer { grid-template-columns: 1fr; }
  .plan-blurb { min-height: 0; }
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
  const updateChoice = () => {
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
    updateChoice();
  }));
  efforts.forEach((effort) => effort.addEventListener("click", () => {
    size = effort.dataset.size;
    updateChoice();
  }));
  const updateModel = () => {
    const choice = modelSelect.value === "other"
      ? { model: otherModel.value.trim(), provider: form.dataset.provider }
      : modelSelect.value ? JSON.parse(modelSelect.value) : { model: "", provider: "" };
    model = choice.model;
    provider = model ? choice.provider : "";
    updateChoice();
  };
  modelSelect.addEventListener("change", updateModel);
  otherModel.addEventListener("input", updateModel);
  customize.addEventListener("click", () => {
    drawer.hidden = !drawer.hidden;
    customize.setAttribute("aria-expanded", String(!drawer.hidden));
    document.getElementById("customize-label").textContent = drawer.hidden ? "Customize" : "Hide";
  });
  updateChoice();
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
    mode.textContent = hasProject
      ? "Reads " + selected.dataset.name + " · no workflows"
      : chatMode;
  });
  // The host's frame sandbox grants allow-scripts only, never allow-forms, so a
  // form never fires submit here; Start is a plain click.
  const startSwarm = () => {
    if (start.disabled) return;
    const payload = {
      nonce: form.dataset.nonce,
      task: task.value,
      project: project.value,
      tools: project.value ? "read" : "none"
    };
    if (model) {
      payload.size = size;
      payload.model = model;
      if (provider) payload.provider = provider;
    } else if (size !== "medium" || power !== "balanced") {
      payload.size = size;
      if (power !== "balanced") payload.power = power;
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
  return `<style>${designTokenCssBlock()}\n${PAGE_CSS}</style>
<main>
  <header>
    <span class="glyph" aria-hidden="true">▶</span>
    <div class="intro"><h1>Start a swarm</h1><p class="hint">Describe the problem. Agents investigate, debate, and bring back a conclusion.</p></div>
    <button class="prepare" id="launch-prepare" type="button">Prepare in chat · attach an issue or PR</button>
  </header>
  <form id="launch-form" data-nonce="${esc(nonce)}" data-provider="${esc(state.provider ?? "")}" data-models="${esc(JSON.stringify(models))}" data-details="${esc(JSON.stringify(details))}" data-budgets="${esc(JSON.stringify(budgets))}">
    <div class="fields">
      <label for="launch-task">TASK</label>
      <textarea id="launch-task" name="task" rows="4" required aria-describedby="task-hint" placeholder="${esc(TASK_PLACEHOLDER)}"></textarea>
      <p class="hint task-hint" id="task-hint">Agents can't open links. Paste the text, or use Prepare in chat to attach the issue or PR.</p>
      <section class="plans" aria-labelledby="plans-heading">
        <div class="plans-heading"><span class="eyebrow" id="plans-heading">HOW HARD IT WORKS</span><span class="chip" id="custom-chip" hidden>custom</span><button class="customize" id="launch-customize" type="button" aria-expanded="false" aria-controls="launch-drawer"><span id="customize-label">Customize</span><span class="chevron" aria-hidden="true">⌄</span></button></div>
        <div class="plan-cards">${cards}</div>
        <div class="drawer" id="launch-drawer" hidden>
          <div><label id="effort-label">EFFORT</label><div class="effort-pills" role="group" aria-labelledby="effort-label">${SWARM_SIZES.map((s) => `<button id="effort-${s}" type="button" data-size="${s}" aria-pressed="${s === "medium"}">${s}</button>`).join("")}</div><p class="hint detail" id="effort-detail">${esc(details.medium!)}</p></div>
          <div><label for="launch-model">MODEL</label><select id="launch-model" name="model"><option value="" selected>the plan's models</option>${modelOptions}<option value="other">Other…</option></select><div class="other-model" id="other-model-row" hidden><label for="launch-other-model">Model name</label><input id="launch-other-model" type="text" autocomplete="off"></div><p class="hint detail" id="model-detail">Keeps the plan's pair: ${esc(models.balanced!)}.</p></div>
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
      </div>
    </div>
    <footer>
      <button class="start" id="launch-start" type="button">Start swarm</button>
      <div aria-live="polite"><p id="launch-summary">${budgets.medium} · balanced models</p><p class="models" id="launch-models">${esc(models.balanced!)}</p></div>
      <p class="mode" id="launch-mode">Chat mode · nothing on disk</p>
    </footer>
  </form>
</main><script>${PAGE_SCRIPT}</script>`;
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

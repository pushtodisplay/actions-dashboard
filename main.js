/*
 * Actions Dashboard — own-job status on a Push to Display board.
 *
 * One report step per job, placed anywhere:
 *   - first step (nothing has run yet): "● started"
 *   - middle of the job: add progress: "true" → "● in progress"
 *   - last step: "✓ done", or "✗ failed · <ids>" / "✗ cancelled · <ids>"
 *
 * The job's own step results come from the calling workflow's steps context,
 * passed as steps-json = toJSON(steps) and computed by GitHub itself. The
 * steps context only contains id-bearing steps that have already run, so a
 * report placed mid-job can only see what ran before it — and the runner
 * exposes no total step count to compare against. Hence the progress flag:
 * the caller is the only one who knows the report is not the last step.
 *
 * No GitHub API, no GITHUB_TOKEN, no permissions needed.
 *
 * Fails soft: any error emits an annotation warning; the process exits 0 —
 * the workflow result is never affected. No dependencies, no retries, 30s
 * bound on the one request the action makes (to Push to Display).
 *
 * Reads inputs from INPUT_* env (set by the runner from action.yml inputs):
 *   INPUT_STEPS-JSON, INPUT_PROGRESS, INPUT_API-KEY, INPUT_API-URL,
 *   INPUT_BOARD-ID, INPUT_PANEL-ID, INPUT_PRD-PANEL, INPUT_DEV-PANEL,
 *   INPUT_PRD-BRANCH, INPUT_LABEL
 * plus runner env: GITHUB_WORKFLOW, GITHUB_JOB, GITHUB_REF, GITHUB_REF_NAME,
 *   GITHUB_HEAD_REF, GITHUB_SHA, GITHUB_OUTPUT
 * plus fallbacks: PUSH_TO_DISPLAY_API_KEY, PUSH_TO_DISPLAY_BOARD.
 */
const { appendFileSync } = require("node:fs");

const env = process.env;
const REQUEST_TIMEOUT_MS = 30_000; // the action owns its own bound

// Palette mirrors compose/stg/utils/sendnotification (same flat-UI family),
// with every color verified ≥ 4.5:1 contrast on the #2c3e50 background.
const COLOR = {
  text: "#e8e8e8", // message text — 8.96:1
  muted: "#aab7b8", // branch · sha — 5.32:1
  ok: "#2ecc71", // green — done — 5.23:1
  fail: "#f1948a", // red — failed — 4.89:1
  warn: "#f5b041", // amber — cancelled — 5.84:1
  running: "#85c1e9", // blue — started / in progress — 5.65:1
};
const BACKGROUND = "#2c3e50";

// Branch name color follows the sendnotification env convention (stg amber,
// prd green, dev blue, anything else gray), lightened where needed to clear
// 4.5:1 on the background. "prd" = the prd-branch input (default main).
const ENV_COLOR = {
  prd: "#2ecc71", // 5.23:1
  stg: "#f5b041", // 5.84:1
  dev: "#85c1e9", // 5.65:1
  other: "#aab7b8", // 5.32:1
};

// Workflow/job names get a deterministic color: FNV-1a hash → hue, with
// saturation/lightness fixed so EVERY hue clears 4.5:1 on the background
// (worst hue 240 = 4.92:1). Same name → same color, on any machine, forever.
const NAME_SATURATION = 0.55;
const NAME_LIGHTNESS = 0.78;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// ---------- helpers ----------

function warn(msg) {
  console.log(`::warning::Push to Display: ${msg}`);
}

// Inputs arrive as INPUT_<NAME> with the name uppercased (spaces → underscores)
// but hyphens KEPT — e.g. steps-json → INPUT_STEPS-JSON (@actions/core
// convention). Fall back to the hyphen→underscore form for lenient runs.
function input(name) {
  const key = name.replace(/ /g, "_").toUpperCase();
  const value =
    env[`INPUT_${key}`] ?? env[`INPUT_${key.replace(/-/g, "_")}`] ?? "";
  return value.trim();
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test((value || "").trim());
}

// FNV-1a 32-bit over the lowercased name — stable across runs and machines.
function hash32(name) {
  let h = 0x811c9dc5;
  for (const ch of name.toLowerCase()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const to = (v) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function nameColor(name) {
  return hslToHex(
    hash32(name) % 360,
    NAME_SATURATION,
    NAME_LIGHTNESS,
  );
}

// sendnotification timestamp format (HH:MM:SS Mon DD), pinned to UTC.
function utcTimestamp(now = new Date()) {
  const [date, time] = now.toISOString().split("T");
  const [, month, day] = date.split("-");
  return `${time.slice(0, 8)} ${MONTHS[Number(month) - 1]} ${day} UTC`;
}

function writeOutput(name, value) {
  const out = env.GITHUB_OUTPUT;
  if (!out) return;
  appendFileSync(out, `${name}<<PTD_EOF\n${value}\nPTD_EOF\n`);
}

// ---------- run facts (lazy: tests and runners may set env late) ----------

function getLabel() {
  return input("label") || env.GITHUB_WORKFLOW || "workflow";
}

function getBranch() {
  const ref = env.GITHUB_REF || "";
  return (
    env.GITHUB_HEAD_REF ||
    env.GITHUB_REF_NAME ||
    (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref)
  );
}

function getSha() {
  return (env.GITHUB_SHA || "").slice(0, 7);
}

function getSelfJob() {
  return env.GITHUB_JOB || "";
}

function resolvePanel() {
  const override = input("panel-id");
  if (override) return override;
  const prdBranch = input("prd-branch") || "main";
  return env.GITHUB_REF === `refs/heads/${prdBranch}`
    ? input("prd-panel") || "1"
    : input("dev-panel") || "2";
}

function branchColor() {
  const branch = getBranch();
  if (branch === (input("prd-branch") || "main")) return ENV_COLOR.prd;
  if (branch === "stg") return ENV_COLOR.stg;
  if (branch === "dev") return ENV_COLOR.dev;
  return ENV_COLOR.other;
}

// ---------- own-job status ----------

// Steps that are not the user's own: runner machinery (Set up job, Post …,
// Complete job) and the Push to Display reporter itself. Service-container
// steps are keyed by a runner-generated UUID, not a name — and they run
// before the first user step, so a uuid-shaped key would otherwise make a
// just-started services job look like a finished one. User steps always
// carry the id: they declare, so uuid keys are never user steps.
function isHiddenStep(key) {
  const k = (key || "").toLowerCase();
  return (
    k === "set-up-job" ||
    k === "complete-job" ||
    k === "initialize-containers" ||
    k === "stop-containers" ||
    k.startsWith("post-") ||
    /^[0-9a-f]{32}$/.test(k) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(k) ||
    k.includes("report-to-display") ||
    k.includes("push-to-display") ||
    k.includes("pushtodisplay")
  );
}

// Step ids shown as GitHub normalized them; tidy runs of hyphens.
function displayStepName(key) {
  return (key || "").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function parseStepsJson() {
  const raw = input("steps-json");
  if (!raw) {
    console.log("Push to Display: steps-json input (empty)");
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    console.log(
      `Push to Display: steps-json input (${raw.length} chars): ${raw}`,
    );
    return parsed;
  } catch (error) {
    console.log(
      `Push to Display: unparsable steps-json input (${raw.length} chars): ${raw}`,
    );
    return null;
  }
}

// Every message: branch (env color), workflow and job (hash colors), then
// the commit hash to the right of the job name.
function metaBlocks() {
  const label = getLabel();
  const job = getSelfJob();
  return [
    {
      text: getBranch(),
      size: "small",
      color: branchColor(),
    },
    {
      text: `[${label}]`,
      size: "small",
      color: nameColor(label),
    },
    {
      text: `[${job}]`,
      size: "small",
      color: nameColor(job),
    },
    {
      text: getSha(),
      size: "small",
      color: COLOR.muted,
    },
  ];
}

function timeBlock() {
  return { text: utcTimestamp(), size: "small", color: COLOR.muted };
}

function buildBlocks() {
  const stepsJson = parseStepsJson();
  if (stepsJson === null) {
    warn(
      "steps-json missing or unparsable — pass with: steps-json: ${{ toJSON(steps) }}; only run metadata pushed",
    );
    return [...metaBlocks(), timeBlock()];
  }

  const terminal = Object.entries(stepsJson)
    .map(([key, value]) => ({
      key,
      conclusion: (value && (value.conclusion || value.outcome)) || null,
    }))
    .filter(
      (s) =>
        !isHiddenStep(s.key) &&
        (s.conclusion === "success" ||
          s.conclusion === "failure" ||
          s.conclusion === "cancelled" ||
          s.conclusion === "skipped"),
    );

  const failed = terminal.filter((s) => s.conclusion === "failure");
  const cancelled = terminal.filter((s) => s.conclusion === "cancelled");
  const names = (steps) =>
    steps.map((s) => displayStepName(s.key)).join(", ");

  let status;
  if (terminal.length === 0) {
    // Nothing has run yet: the report step is the job's first step.
    status = { text: "\u25cf started", color: COLOR.running };
  } else if (failed.length) {
    status = {
      text: `\u2717 failed \u00b7 ${names(failed)}`,
      color: COLOR.fail,
    };
  } else if (cancelled.length) {
    status = {
      text: `\u2717 cancelled \u00b7 ${names(cancelled)}`,
      color: COLOR.warn,
    };
  } else if (isTruthy(input("progress"))) {
    // Mid-job report: the caller declared the job is not finished.
    status = { text: "\u25cf in progress", color: COLOR.running };
  } else {
    status = { text: "\u2713 done", color: COLOR.ok };
  }

  return [
    ...metaBlocks(),
    { text: status.text, size: "small", color: status.color },
    timeBlock(),
  ];
}

// ---------- Push to Display API ----------

async function pushToDisplay(panelId, blocks) {
  const apiUrl = input("api-url") || "https://api.pushtodisplay.com";
  const apiKey = input("api-key") || env.PUSH_TO_DISPLAY_API_KEY || "";
  const boardId = input("board-id") || env.PUSH_TO_DISPLAY_BOARD || "";
  if (!apiKey) {
    warn(
      "missing API key — set the api-key input or env PUSH_TO_DISPLAY_API_KEY; no message pushed",
    );
    return;
  }

  const url = `${apiUrl}/v1/updates`;
  const payload = { boardId, panelId, blocks, background: BACKGROUND };
  console.log(
    `Push to Display: payload to send → ${url}: ${JSON.stringify(payload)}`,
  );
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if ((error && error.name) === "TimeoutError") {
      throw new Error(
        `Push to Display API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
      );
    }
    throw error;
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `Push to Display API returned ${response.status}: ${body}`
        .replace(/\r?\n/g, " ")
        .replace(/\s+/g, " "),
    );
  }
  console.log(`Push to Display: message pushed, panel ${panelId}`);
}

// ---------- main ----------

// Never throws, never exits non-zero: the workflow result is untouched.
async function run() {
  process.exitCode = 0;
  let panelId;
  try {
    panelId = resolvePanel();
    const blocks = buildBlocks();
    writeOutput("panel-id", panelId);
    try {
      await pushToDisplay(panelId, blocks);
    } catch (pushErr) {
      // The push failing never fails the workflow.
      warn(pushErr.message);
    }
  } catch (err) {
    warn(err.message);
    panelId = resolvePanel();
    writeOutput("panel-id", panelId);
  }
}

if (require.main === module) {
  run().finally(() => process.exit(0));
}

module.exports = {
  warn,
  input,
  isTruthy,
  hash32,
  hslToHex,
  nameColor,
  utcTimestamp,
  timeBlock,
  writeOutput,
  getLabel,
  getBranch,
  getSha,
  getSelfJob,
  resolvePanel,
  branchColor,
  isHiddenStep,
  displayStepName,
  parseStepsJson,
  metaBlocks,
  buildBlocks,
  pushToDisplay,
  run,
};

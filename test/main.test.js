/*
 * Unit tests for the Actions Dashboard action. node --test, zero deps.
 *
 * The failure behavior is mock-tested: "the job failed, the report step
 * still runs" (if: always() on the runner) is modeled here by feeding the
 * action a steps-json whose steps carry failure/cancelled conclusions and
 * asserting the status line is rendered and posted. fetch is mocked; no
 * network, no real board, no real key.
 *
 * Color contract: every emitted color must clear 4.5:1 WCAG contrast on the
 * #2c3e50 background — asserted by sweeping all 360 name hues.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const action = require("../main.js");

// ---------- helpers ----------

const ENV_PREFIXES = /^(INPUT_|GITHUB_|PUSH_TO_DISPLAY_)/;
const BACKGROUND = "#2c3e50";

const META = [
  { text: "dev", size: "small", color: "#85c1e9" },
  { text: "[Backend Pipeline]", size: "small", color: "#e6a8be" },
  { text: "[build-and-test]", size: "small", color: "#cfe6a8" },
  { text: "abcdef1", size: "small", color: "#aab7b8" },
];

const statusOf = (blocks) => blocks[blocks.length - 2];
const stripTime = (blocks) => blocks.slice(0, -1);

function assertTimestamp(blocks) {
  const last = blocks[blocks.length - 1];
  assert.match(last.text, /^\d{2}:\d{2}:\d{2} [A-Z][a-z]{2} \d{2} UTC$/);
  assert.strictEqual(last.size, "small");
  assert.strictEqual(last.color, "#aab7b8");
}

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (ENV_PREFIXES.test(key)) delete process.env[key];
  }
}

function setEnv(values = {}) {
  Object.assign(process.env, values);
}

function captureLogs() {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  return {
    logs,
    restore() {
      console.log = original;
    },
  };
}

function mockFetch(impl) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    return impl(url, init, calls.length);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function okResponse() {
  return { ok: true, status: 200, text: async () => "{}" };
}

function errResponse(status, body) {
  return { ok: false, status, text: async () => body };
}

function relativeLuminance(hex) {
  const [r, g, b] = [1, 3, 5].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  const f = (c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(hex, bg = BACKGROUND) {
  const a = relativeLuminance(hex);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test.beforeEach(() => {
  resetEnv();
  setEnv({
    GITHUB_WORKFLOW: "Backend Pipeline",
    GITHUB_JOB: "build-and-test",
    GITHUB_REF: "refs/heads/dev",
    GITHUB_REF_NAME: "dev",
    GITHUB_SHA: "abcdef1234567890",
  });
});

test.afterEach(() => {
  resetEnv();
});

test("input: hyphen form (runner convention) and underscore form both work", () => {
  setEnv({ "INPUT_STEPS-JSON": "{\"a\": {}}" });
  assert.strictEqual(action.input("steps-json"), "{\"a\": {}}");
  delete process.env["INPUT_STEPS-JSON"];
  setEnv({ INPUT_STEPS_JSON: "{\"b\": {}}" });
  assert.strictEqual(action.input("steps-json"), "{\"b\": {}}");
});

// ---------- name colors ----------

test("name colors are deterministic and case-insensitive", () => {
  assert.strictEqual(action.nameColor("Backend Pipeline"), "#e6a8be");
  assert.strictEqual(action.nameColor("detect-changes"), "#a8b6e6");
  assert.strictEqual(action.nameColor("build-and-test"), "#cfe6a8");
  assert.strictEqual(
    action.nameColor("Detect-Changes"),
    action.nameColor("detect-changes"),
  );
});

test("every possible name color clears 4.5:1 on the background", () => {
  let worst = Infinity;
  let worstHue = 0;
  for (let hue = 0; hue < 360; hue++) {
    const ratio = contrast(action.hslToHex(hue, 0.55, 0.78));
    if (ratio < worst) {
      worst = ratio;
      worstHue = hue;
    }
  }
  assert.ok(
    worst >= 4.5,
    `worst hue ${worstHue} is only ${worst.toFixed(2)}:1`,
  );
});

test("branch color follows the sendnotification env convention", () => {
  setEnv({ GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main" });
  assert.strictEqual(action.branchColor(), "#2ecc71");
  setEnv({ GITHUB_REF: "refs/heads/stg", GITHUB_REF_NAME: "stg" });
  assert.strictEqual(action.branchColor(), "#f5b041");
  setEnv({ GITHUB_REF: "refs/heads/dev", GITHUB_REF_NAME: "dev" });
  assert.strictEqual(action.branchColor(), "#85c1e9");
  setEnv({ GITHUB_REF: "refs/heads/copilot/x", GITHUB_REF_NAME: "copilot/x" });
  assert.strictEqual(action.branchColor(), "#aab7b8");
});

test("branch color honors a custom prd-branch", () => {
  setEnv({
    GITHUB_REF: "refs/heads/prod",
    GITHUB_REF_NAME: "prod",
    "INPUT_PRD-BRANCH": "prod",
  });
  assert.strictEqual(action.branchColor(), "#2ecc71");
});

test("status palette clears 4.5:1 on the background", () => {
  for (const hex of [
    "#e8e8e8",
    "#aab7b8",
    "#2ecc71",
    "#f1948a",
    "#f5b041",
    "#85c1e9",
  ]) {
    const ratio = contrast(hex);
    assert.ok(ratio >= 4.5, `${hex} is only ${ratio.toFixed(2)}:1`);
  }
});

test("timestamp: sendnotification format, pinned to UTC", () => {
  assert.strictEqual(
    action.utcTimestamp(new Date("2026-09-09T09:17:53.549Z")),
    "09:17:53 Sep 09 UTC",
  );
  assert.strictEqual(
    action.utcTimestamp(new Date("2026-01-01T00:00:00Z")),
    "00:00:00 Jan 01 UTC",
  );
});

test("timestamp is UTC regardless of the runner timezone", () => {
  const original = process.env.TZ;
  try {
    for (const tz of ["America/New_York", "Asia/Tokyo", "UTC"]) {
      process.env.TZ = tz;
      assert.strictEqual(
        action.utcTimestamp(new Date("2026-09-09T09:17:53Z")),
        "09:17:53 Sep 09 UTC",
        `failed under TZ=${tz}`,
      );
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

// ---------- status rendering ----------

test("first position (empty steps context): started", () => {
  setEnv({ "INPUT_STEPS-JSON": "{}" });
  const blocks = action.buildBlocks();
  assert.deepStrictEqual(stripTime(blocks), [
    ...META,
    { text: "\u25cf started", size: "small", color: "#85c1e9" },
  ]);
  assertTimestamp(blocks);
});

test("services job at first position: container UUID step is hidden, still started", () => {
  setEnv({
    "INPUT_STEPS-JSON": JSON.stringify({
      "3edeadad5d974c0a83300afae48ec755": {
        outputs: {},
        outcome: "success",
        conclusion: "success",
      },
    }),
  });
  assert.deepStrictEqual(stripTime(action.buildBlocks()), [
    ...META,
    { text: "\u25cf started", size: "small", color: "#85c1e9" },
  ]);
});

test("all steps succeeded: done", () => {
  setEnv({
    "INPUT_STEPS-JSON": JSON.stringify({
      checkout: { conclusion: "success" },
      build: { conclusion: "success" },
      test: { conclusion: "success" },
    }),
  });
  const blocks = action.buildBlocks();
  assert.deepStrictEqual(stripTime(blocks), [
    ...META,
    { text: "\u2713 done", size: "small", color: "#2ecc71" },
  ]);
  assertTimestamp(blocks);
});

test("skipped steps do not fail the job: done", () => {
  setEnv({
    "INPUT_STEPS-JSON": JSON.stringify({
      lint: { conclusion: "skipped" },
      build: { conclusion: "success" },
    }),
  });
  const line = statusOf(action.buildBlocks());
  assert.strictEqual(line.text, "\u2713 done");
  assert.strictEqual(line.color, "#2ecc71");
});

test("mocked always(): failed steps are named in the status line", () => {
  setEnv({
    "INPUT_STEPS-JSON": JSON.stringify({
      checkout: { conclusion: "success" },
      build: { conclusion: "failure" },
      test: { conclusion: "failure" },
      deploy: { conclusion: "skipped" },
    }),
  });
  assert.deepStrictEqual(stripTime(action.buildBlocks()), [
    ...META,
    {
      text: "\u2717 failed \u00b7 build, test",
      size: "small",
      color: "#f1948a",
    },
  ]);
});

test("mocked always(): cancelled steps render amber", () => {
  setEnv({
    "INPUT_STEPS-JSON": JSON.stringify({
      checkout: { conclusion: "success" },
      "build-and-push": { conclusion: "cancelled" },
    }),
  });
  assert.deepStrictEqual(stripTime(action.buildBlocks()), [
    ...META,
    {
      text: "\u2717 cancelled \u00b7 build-and-push",
      size: "small",
      color: "#f5b041",
    },
  ]);
});

test("failure wins over cancellation; only failed ids are named", () => {
  setEnv({
    "INPUT_STEPS-JSON": JSON.stringify({
      build: { conclusion: "failure" },
      deploy: { conclusion: "cancelled" },
    }),
  });
  const line = statusOf(action.buildBlocks());
  assert.strictEqual(line.text, "\u2717 failed \u00b7 build");
  assert.strictEqual(line.color, "#f1948a");
});

test("progress input: mid-job report says in progress", () => {
  setEnv({
    "INPUT_STEPS-JSON": JSON.stringify({ checkout: { conclusion: "success" } }),
    "INPUT_PROGRESS": "true",
  });
  assert.deepStrictEqual(stripTime(action.buildBlocks()), [
    ...META,
    { text: "\u25cf in progress", size: "small", color: "#85c1e9" },
  ]);
});

test("progress input does not mask a failure", () => {
  setEnv({
    "INPUT_STEPS-JSON": JSON.stringify({ build: { conclusion: "failure" } }),
    "INPUT_PROGRESS": "true",
  });
  assert.strictEqual(
    statusOf(action.buildBlocks()).text,
    "\u2717 failed \u00b7 build",
  );
});

test("progress input is ignored when nothing has run yet", () => {
  setEnv({ "INPUT_STEPS-JSON": "{}", "INPUT_PROGRESS": "true" });
  assert.strictEqual(statusOf(action.buildBlocks()).text, "\u25cf started");
});

test("runner machinery and report steps are hidden", () => {
  setEnv({
    "INPUT_STEPS-JSON": JSON.stringify({
      "set-up-job": { conclusion: "success" },
      "report-to-display----start-": { conclusion: "success" },
      "initialize-containers": { conclusion: "success" },
      "run-actions-checkout-v4": { conclusion: "success" },
      "post-run-actions-checkout-v4": { conclusion: "success" },
      "complete-job": { conclusion: "success" },
    }),
  });
  assert.strictEqual(statusOf(action.buildBlocks()).text, "\u2713 done");
});

test("current report step (no conclusion yet) is ignored", () => {
  setEnv({
    "INPUT_STEPS-JSON": JSON.stringify({
      checkout: { conclusion: "success" },
      "report-to-display----end-": { conclusion: null, outcome: null },
    }),
  });
  assert.strictEqual(statusOf(action.buildBlocks()).text, "\u2713 done");
});

test("outcome is honored when conclusion is absent", () => {
  setEnv({
    "INPUT_STEPS-JSON": JSON.stringify({ test: { outcome: "failure" } }),
  });
  assert.strictEqual(
    statusOf(action.buildBlocks()).text,
    "\u2717 failed \u00b7 test",
  );
});

test("missing steps-json warns and pushes metadata only", () => {
  const cap = captureLogs();
  try {
    const blocks = action.buildBlocks();
    assert.deepStrictEqual(stripTime(blocks), META);
    assertTimestamp(blocks);
    assert.ok(
      cap.logs.some((l) => l.includes("steps-json missing")),
      "expected a warning about steps-json",
    );
  } finally {
    cap.restore();
  }
});

test("unparsable steps-json warns and pushes metadata only", () => {
  setEnv({ "INPUT_STEPS-JSON": "{nope" });
  const cap = captureLogs();
  try {
    assert.deepStrictEqual(stripTime(action.buildBlocks()), META);
    assert.ok(cap.logs.some((l) => l.includes("steps-json missing")));
  } finally {
    cap.restore();
  }
});

// ---------- panel resolution ----------

test("panel: main branch goes to prd panel, other branches to dev panel", () => {
  setEnv({ GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main" });
  assert.strictEqual(action.resolvePanel(), "1");
  setEnv({ GITHUB_REF: "refs/heads/dev", GITHUB_REF_NAME: "dev" });
  assert.strictEqual(action.resolvePanel(), "2");
});

test("panel: explicit panel-id wins over branch", () => {
  setEnv({ "INPUT_PANEL-ID": "3", GITHUB_REF: "refs/heads/dev" });
  assert.strictEqual(action.resolvePanel(), "3");
});

test("panel: prd-branch input overrides default main", () => {
  setEnv({
    GITHUB_REF: "refs/heads/prod",
    GITHUB_REF_NAME: "prod",
    "INPUT_PRD-BRANCH": "prod",
  });
  assert.strictEqual(action.resolvePanel(), "1");
});

// ---------- push: mocked fetch ----------

test("push: posts payload with background and the api key", async () => {
  const fetchMock = mockFetch(() => okResponse());
  try {
    setEnv({
      "INPUT_API-KEY": "test-key",
      "INPUT_API-URL": "http://board.test",
      "INPUT_BOARD-ID": "board-1",
    });
    const blocks = action.metaBlocks();
    await action.pushToDisplay("2", blocks);
    assert.strictEqual(fetchMock.calls.length, 1);
    const { url, init } = fetchMock.calls[0];
    assert.strictEqual(url, "http://board.test/v1/updates");
    assert.strictEqual(init.method, "POST");
    assert.strictEqual(init.headers["X-Api-Key"], "test-key");
    const body = JSON.parse(init.body);
    assert.strictEqual(body.panelId, "2");
    assert.strictEqual(body.boardId, "board-1");
    assert.strictEqual(body.background, "#2c3e50");
    assert.deepStrictEqual(body.blocks, blocks);
  } finally {
    fetchMock.restore();
  }
});

test("push: missing api key warns and never fetches", async () => {
  const fetchMock = mockFetch(() => okResponse());
  const cap = captureLogs();
  try {
    setEnv({ "INPUT_API-URL": "http://board.test" });
    await action.pushToDisplay("2", action.metaBlocks());
    assert.strictEqual(fetchMock.calls.length, 0);
    assert.ok(cap.logs.some((l) => l.includes("missing API key")));
  } finally {
    fetchMock.restore();
    cap.restore();
  }
});

test("push: api error throws a descriptive error (run() warns, exit stays 0)", async () => {
  const fetchMock = mockFetch(() => errResponse(401, "unauthorized"));
  try {
    setEnv({ "INPUT_API-KEY": "bad", "INPUT_API-URL": "http://board.test" });
    await assert.rejects(
      action.pushToDisplay("2", action.metaBlocks()),
      /401/,
    );
  } finally {
    fetchMock.restore();
  }
});

test("push: timeout is surfaced as a clear timeout error", async () => {
  const fetchMock = mockFetch(() => {
    throw { name: "TimeoutError" };
  });
  try {
    setEnv({ "INPUT_API-KEY": "k", "INPUT_API-URL": "http://board.test" });
    await assert.rejects(
      action.pushToDisplay("2", action.metaBlocks()),
      /timed out after 30s/,
    );
  } finally {
    fetchMock.restore();
  }
});

// ---------- run(): fail-soft end to end ----------

test("run(): missing key + temp output file — warns, writes panel-id, exit 0", async () => {
  const outFile = path.join(os.tmpdir(), `ptd-test-${process.pid}.txt`);
  const fetchMock = mockFetch(() => okResponse());
  const cap = captureLogs();
  try {
    setEnv({
      GITHUB_OUTPUT: outFile,
      "INPUT_STEPS-JSON": JSON.stringify({
        checkout: { conclusion: "success" },
      }),
    });
    await action.run();
    assert.strictEqual(process.exitCode, 0);
    assert.ok(cap.logs.some((l) => l.includes("missing API key")));
    const written = fs.readFileSync(outFile, "utf8");
    assert.ok(written.includes("panel-id<<PTD_EOF\n2\nPTD_EOF"));
  } finally {
    fetchMock.restore();
    cap.restore();
    fs.rmSync(outFile, { force: true });
  }
});

test("run(): push failure still writes panel-id and does not throw", async () => {
  const outFile = path.join(os.tmpdir(), `ptd-test-${process.pid}-b.txt`);
  let fetchMock;
  const cap = captureLogs();
  try {
    fetchMock = mockFetch(() => errResponse(500, "boom"));
    setEnv({
      "INPUT_API-KEY": "k",
      "INPUT_API-URL": "http://board.test",
      GITHUB_OUTPUT: outFile,
      "INPUT_STEPS-JSON": "{}",
    });
    await action.run();
    assert.strictEqual(process.exitCode, 0);
    assert.ok(cap.logs.some((l) => l.includes("500")));
    const written = fs.readFileSync(outFile, "utf8");
    assert.ok(written.includes("panel-id"));
  } finally {
    if (fetchMock) fetchMock.restore();
    cap.restore();
    fs.rmSync(outFile, { force: true });
  }
});

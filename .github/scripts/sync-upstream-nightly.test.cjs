const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const workflow = readFileSync(join(__dirname, "../workflows/sync-upstream-nightly.yml"), "utf8");
const script = workflow.match(/          script: \|\n([\s\S]+)$/)?.[1];
assert.ok(script, "Expected the nightly sync script");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sync = new AsyncFunction("github", "context", "core", script.replace(/^            /gm, ""));

const nightly = {
  tag_name: "v0.1.7-nightly.20261103.4138",
  published_at: "2026-11-03T18:43:24Z",
  draft: false,
  target_commitish: "main",
};

function fixture({ releases = [nightly], mergeStatus = 201, mergeError, ref } = {}) {
  const calls = [];
  const summary = [];
  const context = {
    repo: { owner: "alexander-cato", repo: "t3code" },
    ref: ref ?? "refs/heads/main",
    payload: { repository: { default_branch: "main" } },
  };
  const github = {
    rest: {
      repos: {
        listReleases() {},
        async getCommit(params) {
          calls.push(["commit", params]);
          return { data: { sha: "nightly-commit" } };
        },
        async merge(params) {
          calls.push(["merge", params]);
          if (mergeError) throw mergeError;
          return { status: mergeStatus };
        },
      },
    },
    async paginate(_method, params) {
      calls.push(["releases", params]);
      return releases;
    },
  };
  const core = {
    info(message) {
      summary.push(message);
    },
    summary: {
      addHeading() {
        return this;
      },
      addRaw(message) {
        summary.push(message);
        return this;
      },
      async write() {},
    },
  };
  return { run: () => sync(github, context, core), calls, summary };
}

test("merges the newest published nightly tag's exact commit into the fork", async () => {
  const { run, calls } = fixture({
    releases: [
      {
        ...nightly,
        tag_name: "v0.1.7-nightly.20261103.4119",
        published_at: "2026-11-03T08:49:52Z",
      },
      { ...nightly, tag_name: "v0.1.7" },
      { ...nightly, tag_name: "v0.1.7-preview.20261104.9999" },
      { ...nightly, tag_name: "v0.1.7-nightly.20261104.9999", draft: true },
      { ...nightly, tag_name: "v0.1.7-nightly.20261104.9998", published_at: null },
      nightly,
    ],
  });
  await run();
  assert.deepEqual(calls, [
    ["releases", { owner: "pingdotgg", repo: "t3code", per_page: 100 }],
    ["commit", { owner: "pingdotgg", repo: "t3code", ref: nightly.tag_name }],
    [
      "merge",
      {
        owner: "alexander-cato",
        repo: "t3code",
        base: "main",
        head: "nightly-commit",
        commit_message: `chore: sync upstream ${nightly.tag_name}`,
      },
    ],
  ]);
});

test("reports an already integrated nightly without changing the branch again", async () => {
  const { run, summary } = fixture({ mergeStatus: 204 });
  await run();
  assert.match(summary.join("\n"), /Already contains/);
});

test("stops on conflicts without attempting to overwrite fork commits", async () => {
  const mergeError = Object.assign(new Error("Merge conflict"), { status: 409 });
  const { run, calls } = fixture({ mergeError });
  await assert.rejects(run(), /Resolve the conflicts manually/);
  assert.equal(calls.filter(([method]) => method === "merge").length, 1);
});

test("fails closed when no published nightly is available", async () => {
  const { run, calls } = fixture({ releases: [] });
  await assert.rejects(run(), /No published upstream nightly/);
  assert.equal(calls.length, 1);
});

test("refuses manual runs from feature branches before accessing GitHub", async () => {
  const { run, calls } = fixture({ ref: "refs/heads/feature" });
  await assert.rejects(run(), /must run from the fork default branch/);
  assert.equal(calls.length, 0);
});

test("propagates permission and API errors without a fallback update", async () => {
  const mergeError = Object.assign(new Error("Forbidden"), { status: 403 });
  const { run } = fixture({ mergeError });
  await assert.rejects(run(), (error) => error === mergeError);
});

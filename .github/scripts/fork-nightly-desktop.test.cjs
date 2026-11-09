const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const workflow = readFileSync(join(__dirname, "../workflows/fork-nightly-desktop.yml"), "utf8");
const script = workflow.match(/          script: \|\n((?:            .*\n|\n)+)/)?.[1];
assert.ok(script, "Expected the fork release resolver");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const resolve = new AsyncFunction(
  "github",
  "context",
  "core",
  "process",
  script.replace(/^            /gm, ""),
);
const nightly = {
  tag_name: "v0.1.7-nightly.20261104.1",
  published_at: "2026-11-04T00:00:00Z",
  draft: false,
};

function fixture({
  releases = [],
  previousSha = "previous",
  version = "0.1.6",
  ref = "refs/heads/main",
  force = false,
  verified = true,
  committer = "alexander-cato",
  author = "alexander-cato",
  sourceSha = "fork-commit",
} = {}) {
  const outputs = new Map();
  const reads = [];
  const github = {
    rest: {
      repos: {
        listReleases() {},
        async getBranch({ branch }) {
          assert.equal(branch, "fork/nightly");
          return { data: { commit: { sha: "fork-commit" } } };
        },
        async getCommit({ ref }) {
          if (ref === "fork-commit") {
            return {
              data: {
                sha: sourceSha,
                commit: { verification: { verified } },
                committer: { login: committer },
                author: { login: author },
              },
            };
          }
          assert.equal(ref, nightly.tag_name);
          return { data: { sha: previousSha } };
        },
        async getContent({ path, ref }) {
          assert.equal(ref, "fork-commit");
          reads.push(path);
          const content = path.endsWith("package.json")
            ? JSON.stringify({ version })
            : [
                "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_public",
                "T3CODE_CLERK_JWT_TEMPLATE=t3code",
                "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=client_public",
                "T3CODE_RELAY_URL=https://relay.t3.codes",
              ].join("\n");
          return { data: { content: Buffer.from(content).toString("base64") } };
        },
      },
    },
    async paginate() {
      return releases;
    },
  };
  const context = {
    repo: { owner: "alexander-cato", repo: "t3code" },
    ref,
    payload: { repository: { default_branch: "main" } },
    runNumber: 42,
  };
  const core = {
    info() {},
    setOutput(key, value) {
      outputs.set(key, value);
    },
  };
  return {
    run: () => resolve(github, context, core, { env: { FORCE_BUILD: String(force) } }),
    outputs,
    reads,
  };
}

test("pins fork builds and public configuration to the fork branch commit", async () => {
  for (const identity of [
    { committer: "alexander-cato" },
    { committer: "github-actions[bot]", author: "github-actions[bot]" },
    { committer: "web-flow", author: "alexander-cato" },
    { committer: "web-flow", author: "github-actions[bot]" },
  ]) {
    const { run, outputs, reads } = fixture(identity);
    await run();
    assert.equal(outputs.get("ref"), "fork-commit");
    assert.match(outputs.get("version"), /^0\.1\.7-nightly\.\d{8}\.42$/);
    assert.equal(outputs.get("tag"), `v${outputs.get("version")}`);
    assert.equal(outputs.get("build"), "true");
    assert.deepEqual(reads, ["apps/desktop/package.json", ".env.example"]);
  }
});

test("does not rebuild a fork commit that already has a published nightly", async () => {
  const { run, outputs, reads } = fixture({ releases: [nightly], previousSha: "fork-commit" });
  await run();
  assert.equal(outputs.get("build"), "false");
  assert.deepEqual(reads, []);
});

test("manual force builds can publish a newly signed installer for the same fork commit", async () => {
  const { run, outputs } = fixture({
    releases: [nightly],
    previousSha: "fork-commit",
    force: true,
  });
  await run();
  assert.equal(outputs.get("build"), "true");
});

test("draft installers do not suppress a published build", async () => {
  const { run, outputs } = fixture({
    releases: [{ ...nightly, draft: true }],
    previousSha: "fork-commit",
  });
  await run();
  assert.equal(outputs.get("build"), "true");
});

test("refuses feature-branch dispatches, untrusted commits, and invalid source versions", async () => {
  await assert.rejects(fixture({ ref: "refs/heads/feature" }).run(), /default branch/);
  for (const trust of [
    { verified: false },
    { verified: null },
    { verified: "true" },
    { committer: "third-party[bot]", author: "alexander-cato" },
    { committer: "web-flow", author: "third-party[bot]" },
    { sourceSha: "different-commit" },
  ]) {
    const { run, outputs, reads } = fixture(trust);
    await assert.rejects(run(), /verified.*alexander-cato|SHA/);
    assert.notEqual(outputs.get("build"), "true");
    assert.deepEqual(reads, []);
  }
  const { run, outputs } = fixture({ version: "not-a-version" });
  await assert.rejects(run(), /Expected a stable package version/);
  assert.notEqual(outputs.get("build"), "true");
});

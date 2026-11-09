const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
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
  "exec",
  "require",
  script.replace(/^            /gm, ""),
);
const nightly = {
  tag_name: "v0.1.7-nightly.20261104.1",
  published_at: "2026-11-04T00:00:00Z",
  draft: false,
};
const validProvenance = {
  repository: "alexander-cato/t3code",
  ref: "refs/heads/main",
  workflow: "alexander-cato/t3code/.github/workflows/sync-upstream-nightly.yml",
  hosted: true,
  subject: "fork-commit\n",
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
  provenance = null,
} = {}) {
  const outputs = new Map();
  const reads = [];
  const verificationPaths = [];
  const exec = {
    async exec(command, args) {
      assert.equal(command, "gh");
      assert.deepEqual(args.slice(0, 2), ["attestation", "verify"]);
      assert.deepEqual(args.slice(3), [
        "--repo",
        validProvenance.repository,
        "--source-ref",
        validProvenance.ref,
        "--signer-workflow",
        validProvenance.workflow,
        "--deny-self-hosted-runners",
      ]);
      verificationPaths.push(args[2]);
      const subject = readFileSync(args[2], "utf8");
      if (provenance === "error") throw new Error("verification unavailable");
      return provenance &&
        Object.keys(validProvenance).every(
          (key) => provenance[key] === (key === "subject" ? subject : validProvenance[key]),
        )
        ? 0
        : 1;
    },
  };
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
    run: () =>
      resolve(github, context, core, { env: { FORCE_BUILD: String(force) } }, exec, require),
    outputs,
    reads,
    verificationPaths,
  };
}

test("pins fork builds and public configuration to the fork branch commit", async () => {
  for (const identity of [
    { committer: "alexander-cato" },
    {
      committer: "github-actions[bot]",
      author: "github-actions[bot]",
      provenance: validProvenance,
    },
    { committer: "web-flow", author: "alexander-cato" },
    { committer: "web-flow", author: "github-actions[bot]", provenance: validProvenance },
  ]) {
    const { run, outputs, reads, verificationPaths } = fixture(identity);
    await run();
    assert.equal(outputs.get("ref"), "fork-commit");
    assert.match(outputs.get("version"), /^0\.1\.7-nightly\.\d{8}\.42$/);
    assert.equal(outputs.get("tag"), `v${outputs.get("version")}`);
    assert.equal(outputs.get("build"), "true");
    assert.deepEqual(reads, ["apps/desktop/package.json", ".env.example"]);
    assert.equal(verificationPaths.length, identity.provenance ? 1 : 0);
    for (const path of verificationPaths) assert.equal(existsSync(dirname(path)), false);
  }
  for (const provenance of [
    null,
    "error",
    { ...validProvenance, repository: "attacker/t3code" },
    { ...validProvenance, ref: "refs/heads/feature" },
    { ...validProvenance, workflow: "alexander-cato/t3code/.github/workflows/other.yml" },
    { ...validProvenance, hosted: false },
    { ...validProvenance, subject: "different-commit\n" },
  ]) {
    const { run, outputs, reads, verificationPaths } = fixture({
      committer: "web-flow",
      author: "github-actions[bot]",
      provenance,
    });
    await assert.rejects(run(), /attestation|provenance/i);
    assert.equal(outputs.size, 0);
    assert.deepEqual(reads, []);
    assert.equal(verificationPaths.length, 1);
    assert.equal(existsSync(dirname(verificationPaths[0])), false);
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

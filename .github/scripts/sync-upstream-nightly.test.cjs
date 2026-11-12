const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const test = require("node:test");

const workflow = readFileSync(join(__dirname, "../workflows/sync-upstream-nightly.yml"), "utf8");
const script = workflow.match(/          script: \|\n((?:            .*\n|\n)+)/)?.[1];
assert.ok(script, "Expected the nightly resolver");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const resolve = new AsyncFunction(
  "github",
  "context",
  "core",
  "exec",
  "require",
  script.replace(/^            /gm, ""),
);
const nightly = {
  tag_name: "v0.1.7-nightly.20261103.4138",
  published_at: "2026-11-03T18:43:24Z",
  draft: false,
  target_commitish: "main",
};
const validProvenance = {
  repository: "alexander-cato/t3code",
  ref: "refs/heads/main",
  workflow: "alexander-cato/t3code/.github/workflows/sync-upstream-nightly.yml",
  hosted: true,
  subject: "fork-commit\n",
};

function fixture({
  releases = [nightly],
  ref = "refs/heads/main",
  verified = true,
  committer = "alexander-cato",
  author = "alexander-cato",
  sourceSha = "fork-commit",
  provenance = null,
  comparisonStatus = "diverged",
} = {}) {
  const calls = [];
  const outputs = new Map();
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
        async compareCommitsWithBasehead(params) {
          assert.equal(params.owner, "alexander-cato");
          assert.equal(params.basehead, "nightly-commit...fork-commit");
          return { data: { status: comparisonStatus } };
        },
        async getBranch({ branch }) {
          assert.equal(branch, "fork/nightly");
          return { data: { commit: { sha: "fork-commit" } } };
        },
        async getCommit(params) {
          calls.push(params);
          if (params.owner === "alexander-cato") {
            assert.equal(params.ref, "fork-commit");
            return {
              data: {
                sha: sourceSha,
                commit: { verification: { verified } },
                committer: { login: committer },
                author: { login: author },
              },
            };
          }
          return { data: { sha: "nightly-commit" } };
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
  };
  const core = {
    setOutput(key, value) {
      outputs.set(key, value);
    },
  };
  return {
    run: () => resolve(github, context, core, exec, require),
    calls,
    outputs,
    verificationPaths,
  };
}

test("resolves the newest published nightly tag to an immutable commit", async () => {
  const { run, calls, outputs } = fixture({
    releases: [
      {
        ...nightly,
        tag_name: "v0.1.7-nightly.20261103.4119",
        published_at: "2026-11-03T08:49:52Z",
      },
      { ...nightly, tag_name: "v0.1.7" },
      { ...nightly, tag_name: "v0.1.7-preview.20261104.9999" },
      { ...nightly, draft: true },
      { ...nightly, published_at: null },
      nightly,
    ],
  });
  await run();
  assert.deepEqual(calls, [
    { owner: "alexander-cato", repo: "t3code", ref: "fork-commit" },
    { owner: "pingdotgg", repo: "t3code", ref: nightly.tag_name },
  ]);
  assert.equal(outputs.get("sha"), "nightly-commit");
  assert.equal(outputs.get("tag"), nightly.tag_name);
  assert.equal(outputs.get("fork_ref"), "fork-commit");
  assert.equal(outputs.get("needs_sync"), "true");
  for (const comparisonStatus of ["ahead", "identical", "behind", "diverged"]) {
    const candidate = fixture({ comparisonStatus });
    await candidate.run();
    assert.equal(
      candidate.outputs.get("needs_sync"),
      ["ahead", "identical"].includes(comparisonStatus) ? "false" : "true",
    );
  }
  await assert.rejects(fixture({ comparisonStatus: "unknown" }).run(), /comparison/i);
  for (const identity of [
    {
      committer: "github-actions[bot]",
      author: "github-actions[bot]",
      provenance: validProvenance,
    },
    { committer: "web-flow", author: "alexander-cato", provenance: validProvenance },
    { committer: "web-flow", author: "github-actions[bot]", provenance: validProvenance },
  ]) {
    const accepted = fixture(identity);
    await accepted.run();
    assert.equal(accepted.outputs.get("fork_ref"), "fork-commit");
    assert.equal(accepted.verificationPaths.length, identity.provenance ? 1 : 0);
    for (const path of accepted.verificationPaths) assert.equal(existsSync(dirname(path)), false);
  }
});

test("fails closed without a nightly, with an untrusted fork head, or on feature branches", async () => {
  await assert.rejects(fixture({ releases: [] }).run(), /No published upstream nightly/);
  const { run, calls } = fixture({ ref: "refs/heads/feature" });
  await assert.rejects(run(), /must run from the fork default branch/);
  assert.deepEqual(calls, []);
  for (const trust of [
    { verified: false },
    { verified: null },
    { verified: "true" },
    { committer: "third-party[bot]", author: "alexander-cato" },
    { committer: "web-flow", author: "third-party[bot]" },
    { sourceSha: "different-commit" },
  ]) {
    const rejected = fixture(trust);
    await assert.rejects(rejected.run(), /verified.*alexander-cato|SHA/);
    assert.equal(rejected.outputs.size, 0);
    assert.equal(rejected.calls.length, 1);
  }
  await assert.rejects(
    fixture({ committer: "web-flow", author: "alexander-cato" }).run(),
    /attestation|provenance/i,
  );
  for (const provenance of [
    null,
    "error",
    { ...validProvenance, repository: "attacker/t3code" },
    { ...validProvenance, ref: "refs/heads/feature" },
    { ...validProvenance, workflow: "alexander-cato/t3code/.github/workflows/other.yml" },
    { ...validProvenance, hosted: false },
    { ...validProvenance, subject: "different-commit\n" },
  ]) {
    const rejected = fixture({ committer: "web-flow", author: "github-actions[bot]", provenance });
    await assert.rejects(rejected.run(), /attestation|provenance/i);
    assert.equal(rejected.outputs.size, 0);
    assert.equal(rejected.calls.length, 1);
    assert.equal(rejected.verificationPaths.length, 1);
    assert.equal(existsSync(dirname(rejected.verificationPaths[0])), false);
  }
});

function withRepository(body) {
  const directory = mkdtempSync(join(tmpdir(), "t3-nightly-sync-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GITHUB_STEP_SUMMARY: "",
    GITHUB_REPOSITORY: "fixture/nightly",
    GITHUB_OUTPUT: join(directory, ".git/github-output"),
    PATH: `${join(directory, ".git/test-bin")}:${process.env.PATH}`,
  };
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: directory,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (file, value) => {
    const destination = join(directory, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, value);
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Nightly fixture");
    git("config", "user.email", "fixture@example.com");
    write(
      ".git/test-bin/gh",
      `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { appendFileSync, readFileSync } = require("node:fs");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
assert.equal(args[0], "api");
assert.equal(args[args.indexOf("--method") + 1], "POST");
const endpoint = args[1];
const body = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(".git/api-calls", JSON.stringify({ endpoint, body }) + "\\n");
const git = (args, input) => execFileSync("git", args, { input, encoding: "utf8" }).trim();
let response;
if (endpoint.endsWith("/git/blobs")) {
  assert.equal(body.encoding, "base64");
  response = { sha: git(["hash-object", "-t", "blob", "-w", "--stdin"], Buffer.from(body.content, "base64")) };
} else if (endpoint.endsWith("/git/trees")) {
  const entries = body.tree.map(({ mode, type, sha, path }) => mode + " " + type + " " + sha + "\\t" + path + "\\0").join("");
  response = { sha: git(["mktree", "-z", "--missing"], entries) };
} else if (endpoint.endsWith("/git/commits")) {
  assert.deepEqual(Object.keys(body).sort(), ["message", "parents", "tree"]);
  const sha = git(["-c", "commit.gpgsign=false", "commit-tree", body.tree, ...body.parents.flatMap((parent) => ["-p", parent])], body.message);
  response = { sha, tree: { sha: body.tree }, parents: body.parents.map((sha) => ({ sha })), verification: { verified: true } };
  if (process.env.TEST_VERIFICATION === "false") response.verification.verified = false;
  if (process.env.TEST_VERIFICATION === "missing") delete response.verification;
  if (process.env.TEST_VERIFICATION === "string") response.verification.verified = "true";
  if (process.env.TEST_VERIFICATION === "wrong-parent") response.parents.reverse();
  if (process.env.TEST_VERIFICATION === "wrong-tree") response.tree.sha = body.parents[0];
} else {
  throw Error("Unexpected API endpoint: " + endpoint);
}
process.stdout.write(JSON.stringify(response));
`,
    );
    chmodSync(join(directory, ".git/test-bin/gh"), 0o755);
    write("source.txt", "base source\n");
    write("merged.txt", "fork=base\na\nb\nc\nupstream=base\n");
    write(".github/workflows/common.yml", "base workflow\n");
    write(".github/workflows/deleted.yml", "keep this workflow\n");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-b", "fork/nightly");
    write("fork.txt", "fork customization\n");
    write("merged.txt", "fork=custom\na\nb\nc\nupstream=base\n");
    write(".github/workflows/common.yml", "fork workflow\n");
    write(".github/workflows/fork.yml", "fork automation\n");
    git("add", ".");
    git("commit", "-m", "fork customization");
    const fork = git("rev-parse", "HEAD");
    git("checkout", "-b", "upstream", base);
    write("source.txt", "upstream source\n");
    write("merged.txt", "fork=base\na\nb\nc\nupstream=nightly\n");
    write(".github/workflows/common.yml", "upstream workflow\n");
    write(".github/workflows/added.yml", "upstream automation\n");
    git("rm", ".github/workflows/deleted.yml");
    git("add", ".");
    git("commit", "-m", "upstream nightly");
    const upstream = git("rev-parse", "HEAD");
    git("checkout", "fork/nightly");
    const run = () => {
      rmSync(env.GITHUB_OUTPUT, { force: true });
      return spawnSync(
        "bash",
        [join(__dirname, "sync-upstream-nightly.sh"), upstream, nightly.tag_name],
        {
          cwd: directory,
          env,
          encoding: "utf8",
        },
      );
    };
    const output = () =>
      Object.fromEntries(
        readFileSync(env.GITHUB_OUTPUT, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
    body({ directory, git, write, fork, upstream, run, env, output });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("merges source and fork customizations while preserving every fork workflow", () => {
  withRepository(({ directory, git, fork, upstream, run, env, output }) => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const { sha: synced, base, changed } = output();
    assert.equal(base, fork);
    assert.equal(changed, "true");
    assert.equal(output().attestation_sha, synced);
    assert.equal(git("rev-parse", "HEAD"), fork);
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(git("show", `${synced}:source.txt`), "upstream source");
    assert.equal(git("show", `${synced}:fork.txt`), "fork customization");
    assert.equal(git("show", `${synced}:merged.txt`), "fork=custom\na\nb\nc\nupstream=nightly");
    assert.equal(
      git("rev-parse", `${synced}:.github/workflows`),
      git("rev-parse", `${fork}:.github/workflows`),
    );
    assert.equal(existsSync(join(directory, ".github/workflows/added.yml")), false);
    assert.equal(git("rev-parse", `${synced}^1`), fork);
    assert.equal(git("rev-parse", `${synced}^2`), upstream);
    git("reset", "--hard", synced);
    assert.equal(run().status, 0);
    assert.equal(git("rev-parse", "HEAD"), synced);
    assert.equal(output().changed, "false");
    assert.equal(output().attestation_sha, undefined);
    const refs = git("for-each-ref", "--format=%(refname):%(objectname)");
    env.VERIFY_SYNC_SIGNING = "true";
    const proof = run();
    assert.equal(proof.status, 0, proof.stderr);
    const proofSha = /Verified GitHub bot signing with unreferenced commit ([0-9a-f]{40})/.exec(
      proof.stdout,
    )?.[1];
    assert.ok(proofSha, proof.stdout);
    assert.equal(git("rev-parse", `${proofSha}^{tree}`), git("rev-parse", `${synced}^{tree}`));
    assert.equal(git("rev-parse", `${proofSha}^1`), synced);
    assert.equal(git("rev-parse", `${proofSha}^2`), upstream);
    assert.equal(git("for-each-ref", "--format=%(refname):%(objectname)"), refs);
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(output().changed, "false");
    assert.equal(output().attestation_sha, proofSha);
    rmSync(env.GITHUB_OUTPUT);
    env.TEST_VERIFICATION = "false";
    const rejected = run();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /verified/);
    assert.equal(git("for-each-ref", "--format=%(refname):%(objectname)"), refs);
    assert.equal(existsSync(env.GITHUB_OUTPUT), false);
  });
});

test("refuses unverified commits or mismatched merge data before publication", () => {
  for (const verification of ["false", "missing", "string", "wrong-parent", "wrong-tree"]) {
    withRepository(({ git, fork, run, env }) => {
      env.TEST_VERIFICATION = verification;
      const result = run();
      assert.notEqual(result.status, 0, verification);
      assert.match(result.stderr, /verified|parents|tree/);
      assert.equal(git("rev-parse", "HEAD"), fork);
      assert.equal(git("status", "--porcelain"), "");
      assert.equal(existsSync(env.GITHUB_OUTPUT), false);
    });
  }
});

test("aborts source conflicts without publishing a partial merge", () => {
  withRepository(({ directory, git, write, run }) => {
    write("source.txt", "conflicting fork change\n");
    git("add", ".");
    git("commit", "-m", "fork source change");
    const before = git("rev-parse", "HEAD");
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Resolve these source conflicts manually/);
    assert.equal(git("rev-parse", "HEAD"), before);
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(readFileSync(join(directory, "source.txt"), "utf8"), "conflicting fork change\n");
  });
});

test("refuses a dirty checkout without changing local work", () => {
  withRepository(({ directory, git, write, fork, run }) => {
    write("source.txt", "uncommitted work\n");
    assert.notEqual(run().status, 0);
    assert.equal(git("rev-parse", "HEAD"), fork);
    assert.equal(readFileSync(join(directory, "source.txt"), "utf8"), "uncommitted work\n");
  });
});

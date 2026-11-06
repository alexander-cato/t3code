const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
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
  script.replace(/^            /gm, ""),
);
const nightly = {
  tag_name: "v0.1.7-nightly.20261103.4138",
  published_at: "2026-11-03T18:43:24Z",
  draft: false,
  target_commitish: "main",
};

function fixture({ releases = [nightly], ref = "refs/heads/main" } = {}) {
  const calls = [];
  const outputs = new Map();
  const github = {
    rest: {
      repos: {
        listReleases() {},
        async getCommit(params) {
          calls.push(params);
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
  return { run: () => resolve(github, context, core), calls, outputs };
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
  assert.deepEqual(calls, [{ owner: "pingdotgg", repo: "t3code", ref: nightly.tag_name }]);
  assert.equal(outputs.get("sha"), "nightly-commit");
  assert.equal(outputs.get("tag"), nightly.tag_name);
});

test("fails closed without a nightly or when dispatched from a feature branch", async () => {
  await assert.rejects(fixture({ releases: [] }).run(), /No published upstream nightly/);
  const { run, calls } = fixture({ ref: "refs/heads/feature" });
  await assert.rejects(run(), /must run from the fork default branch/);
  assert.deepEqual(calls, []);
});

function withRepository(body) {
  const directory = mkdtempSync(join(tmpdir(), "t3-nightly-sync-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GITHUB_STEP_SUMMARY: "",
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
    write("source.txt", "base source\n");
    write(".github/workflows/common.yml", "base workflow\n");
    write(".github/workflows/deleted.yml", "keep this workflow\n");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-b", "fork/nightly");
    write("fork.txt", "fork customization\n");
    write(".github/workflows/common.yml", "fork workflow\n");
    write(".github/workflows/fork.yml", "fork automation\n");
    git("add", ".");
    git("commit", "-m", "fork customization");
    const fork = git("rev-parse", "HEAD");
    git("checkout", "-b", "upstream", base);
    write("source.txt", "upstream source\n");
    write(".github/workflows/common.yml", "upstream workflow\n");
    write(".github/workflows/added.yml", "upstream automation\n");
    git("rm", ".github/workflows/deleted.yml");
    git("add", ".");
    git("commit", "-m", "upstream nightly");
    const upstream = git("rev-parse", "HEAD");
    git("checkout", "fork/nightly");
    const run = () =>
      spawnSync("bash", [join(__dirname, "sync-upstream-nightly.sh"), upstream, nightly.tag_name], {
        cwd: directory,
        env,
        encoding: "utf8",
      });
    body({ directory, git, write, fork, upstream, run });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("merges source and fork customizations while preserving every fork workflow", () => {
  withRepository(({ directory, git, fork, upstream, run }) => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(directory, "source.txt"), "utf8"), "upstream source\n");
    assert.equal(readFileSync(join(directory, "fork.txt"), "utf8"), "fork customization\n");
    assert.equal(
      git("rev-parse", "HEAD:.github/workflows"),
      git("rev-parse", `${fork}:.github/workflows`),
    );
    assert.equal(existsSync(join(directory, ".github/workflows/added.yml")), false);
    assert.equal(git("rev-parse", "HEAD^2"), upstream);
    const synced = git("rev-parse", "HEAD");
    assert.equal(run().status, 0);
    assert.equal(git("rev-parse", "HEAD"), synced);
  });
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

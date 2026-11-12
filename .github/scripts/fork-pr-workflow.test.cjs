const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

test("compares context growth against the PR base instead of the older default branch", () => {
  const directory = mkdtempSync(join(tmpdir(), "t3-pr-budget-"));
  try {
    const git = (...args) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    const budget = join(directory, "budget.json");
    writeFileSync(budget, JSON.stringify({ context: 10 }));
    git("add", "budget.json");
    git("commit", "-m", "older default branch");
    git("switch", "-c", "fork/nightly");
    writeFileSync(budget, JSON.stringify({ context: 20 }));
    git("commit", "-am", "included upstream nightly");
    const base = git("rev-parse", "HEAD");
    git("switch", "-c", "fork-work/test");
    git("remote", "add", "origin", directory);

    const workflow = readFileSync(join(__dirname, "../workflows/agent-context-budget.yml"), "utf8");
    const script = workflow.split("        run: |\n")[1].replace(/^          /gm, "");
    const run = (allow = "false") =>
      spawnSync("bash", ["-e", "-c", script], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          BUDGET: "budget.json",
          BASE_SHA: base,
          RUNNER_TEMP: directory,
          ALLOW_INCREASE: allow,
        },
      });
    const unchanged = run();
    assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
    writeFileSync(budget, JSON.stringify({ context: 21 }));
    const grown = run();
    assert.equal(grown.status, 1, grown.stdout + grown.stderr);
    assert.match(grown.stdout, /context: 20 -> 21/);
    assert.equal(run("true").status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

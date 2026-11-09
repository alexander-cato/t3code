const { execFileSync } = require("node:child_process");

function git(args, encoding = "utf8") {
  return execFileSync("git", args, { encoding, maxBuffer: 64 * 1024 * 1024 });
}

function entries(tree, recursive = false) {
  return git(["ls-tree", ...(recursive ? ["-r", "-t"] : []), "-z", tree])
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("Unexpected Git tree entry");
      const [, mode, type, sha, path] = match;
      return { mode, type, sha, path };
    });
}

function createVerifiedMerge({ repository, before, upstream, tree, message }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error("GITHUB_REPOSITORY must identify the fork repository");
  }
  const api = (resource, body) =>
    JSON.parse(
      execFileSync(
        "gh",
        ["api", `repos/${repository}/git/${resource}`, "--method", "POST", "--input", "-"],
        {
          input: JSON.stringify(body),
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
    );
  const known = new Set();
  for (const parent of [before, upstream]) {
    known.add(git(["rev-parse", `${parent}^{tree}`]).trim());
    for (const entry of entries(parent, true)) known.add(entry.sha);
  }

  function upload(sha, type) {
    if (known.has(sha) || type === "commit") return;
    let response;
    if (type === "blob") {
      response = api("blobs", {
        content: git(["cat-file", "blob", sha], null).toString("base64"),
        encoding: "base64",
      });
    } else {
      const treeEntries = entries(sha);
      for (const entry of treeEntries) upload(entry.sha, entry.type);
      response = api("trees", { tree: treeEntries });
    }
    if (response.sha !== sha) throw new Error(`GitHub returned an unexpected ${type} object`);
    known.add(sha);
  }

  upload(tree, "tree");
  // GitHub bot signing requires omitting custom author, committer, and signature metadata.
  const commit = api("commits", { message, tree, parents: [before, upstream] });
  if (commit.verification?.verified !== true) {
    throw new Error("GitHub did not return a verified nightly sync commit; refusing publication");
  }
  if (commit.tree?.sha !== tree) throw new Error("GitHub returned an unexpected merge tree");
  if (
    commit.parents?.length !== 2 ||
    commit.parents[0]?.sha !== before ||
    commit.parents[1]?.sha !== upstream
  ) {
    throw new Error("GitHub returned unexpected merge parents");
  }
  if (!/^[0-9a-f]{40}$/.test(commit.sha ?? ""))
    throw new Error("GitHub returned an invalid commit SHA");
  return commit.sha;
}

if (require.main === module) {
  try {
    const [before, upstream, tree, tag] = process.argv.slice(2);
    const sha = createVerifiedMerge({
      repository: process.env.GITHUB_REPOSITORY,
      before,
      upstream,
      tree,
      message: `chore: sync upstream ${tag} (preserve fork workflows)`,
    });
    process.stdout.write(sha);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

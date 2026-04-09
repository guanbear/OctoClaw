#!/usr/bin/env node

const PROJECT_REPOS = {
  openclaw: "openclaw/openclaw",
  octoclaw: "guanbear/OctoClaw",
};

function parseArgs(argv) {
  const args = { project: "", focus: "latest_updates" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--project") args.project = String(argv[index + 1] || "");
    if (token === "--focus") args.focus = String(argv[index + 1] || "");
  }
  return args;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "octoclaw-upstream-release-lookup",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}`);
  }
  return response.json();
}

function normalizeText(value = "") {
  return String(value || "").replace(/\r/g, "").trim();
}

function extractFocusHighlights(body = "", focus = "") {
  const lines = normalizeText(body).split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  let pattern = null;
  if (focus === "memory") pattern = /(memory|dream|dreaming|diary|rem|scene)/iu;
  if (!pattern) return lines.slice(0, 8);
  const hits = lines.filter((line) => pattern.test(line));
  return (hits.length > 0 ? hits : lines).slice(0, 8);
}

async function main() {
  const { project, focus } = parseArgs(process.argv.slice(2));
  const repo = PROJECT_REPOS[String(project || "").toLowerCase()];
  if (!repo) {
    throw new Error(`Unsupported project: ${project}`);
  }

  const [releases, commits] = await Promise.all([
    fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=3`),
    fetchJson(`https://api.github.com/repos/${repo}/commits?per_page=5`),
  ]);

  const latestRelease = Array.isArray(releases) && releases.length > 0 ? releases[0] : null;
  const latestCommit = Array.isArray(commits) && commits.length > 0 ? commits[0] : null;
  const releaseBody = normalizeText(latestRelease?.body || "");
  const highlightLines = extractFocusHighlights(releaseBody, String(focus || ""));

  const lines = [
    `project: ${project}`,
    `repo: ${repo}`,
    `focus: ${focus || "latest_updates"}`,
    `latest_release: ${latestRelease?.tag_name || "none"}`,
    `latest_release_published_at: ${latestRelease?.published_at || ""}`,
    `latest_release_name: ${latestRelease?.name || ""}`,
    `latest_commit_sha: ${String(latestCommit?.sha || "").slice(0, 12)}`,
    `latest_commit_date: ${latestCommit?.commit?.author?.date || ""}`,
    `latest_commit_message: ${normalizeText(latestCommit?.commit?.message || "").split("\n")[0]}`,
  ];

  if (highlightLines.length > 0) {
    lines.push("release_highlights:");
    for (const line of highlightLines) {
      lines.push(`- ${line}`);
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});

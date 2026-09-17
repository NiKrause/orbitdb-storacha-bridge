/**
 * @fileoverview Will Lighthouse accept LIGHTHOUSE_API_KEY? Checked before the live suites,
 * so a bad secret fails once, with a reason, rather than as a wall of refusals.
 *
 *     LIGHTHOUSE_API_KEY=… node test/helpers/check-lighthouse-key.js
 *
 * Asks for the first page of the account's uploads — the cheapest call that needs the
 * key — and prints the status code and facts about the value's shape, never the value.
 */

const raw = process.env.LIGHTHOUSE_API_KEY ?? "";

if (!raw.trim()) {
  console.log("::error::LIGHTHOUSE_API_KEY is empty. Add a Lighthouse API key as a repository secret.");
  process.exit(1);
}

const problems = [];
const token = raw.trim();
if (token !== raw) console.log("note: the value has whitespace around it");
if (/^["'].*["']$/s.test(token)) problems.push("it is wrapped in quotes");
if (/^bearer\s/i.test(token)) problems.push('it starts with "Bearer " — store the key alone');
console.log(`shape: ${token.length} characters, ${token.split(".").length} dot-separated part(s)`);

const api = (process.env.LIGHTHOUSE_API_ORIGIN || "https://api.lighthouse.storage").replace(/\/+$/, "");
let status;
try {
  const response = await fetch(`${api}/api/user/files_uploaded?lastKey=null&fileType=all`, {
    headers: { Authorization: `Bearer ${raw}`, "Content-Type": "application/json" },
  });
  await response.body?.cancel();
  status = response.status;
} catch (error) {
  status = `no response (${error.message})`;
}
console.log(`Lighthouse: upload listing ${typeof status === "number" ? `HTTP ${status}` : status}`);

if (status === 200 && problems.length === 0) {
  console.log("Lighthouse accepts the key.");
  process.exit(0);
}
if (status === 401 || status === 403) {
  if (problems.length === 0) {
    problems.push("Lighthouse does not accept the key — it may be revoked, or not an API key");
  }
} else if (status !== 200) {
  problems.push(
    `the listing gave ${typeof status === "number" ? `HTTP ${status}` : status}, which says nothing about the key — run it again later`,
  );
}
for (const problem of problems) console.log(`::error::LIGHTHOUSE_API_KEY: ${problem}`);
process.exit(1);

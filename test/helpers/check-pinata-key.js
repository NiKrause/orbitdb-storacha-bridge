/**
 * @fileoverview Will Pinata accept PINATA_JWT? Checked before the live suites, so a
 * bad secret fails once, with a reason, rather than as a wall of HTTP 401s.
 *
 *     PINATA_JWT=… node test/helpers/check-pinata-key.js
 *
 * Prints facts about the value's shape and Pinata's status codes, never the value
 * or anything decoded from it: GitHub masks a secret's exact string, not what is
 * derived from it, and a Pinata JWT carries the key's own secret in its payload.
 */

const raw = process.env.PINATA_JWT ?? "";
const problems = [];

if (!raw.trim()) {
  console.log("::error::PINATA_JWT is empty. Add the JWT of a Pinata API key as a repository secret.");
  process.exit(1);
}

let token = raw.trim();
// Harmless — fetch strips it from a header value — but worth knowing.
if (token !== raw) console.log("note: the value has whitespace around it");
if (/^["'].*["']$/s.test(token)) {
  problems.push("it is wrapped in quotes");
  token = token.slice(1, -1);
}
if (/^bearer\s/i.test(token)) {
  problems.push('it starts with "Bearer " — store the token alone');
  token = token.replace(/^bearer\s+/i, "");
}

const parts = token.split(".");
console.log(
  `shape: ${token.length} characters, ${parts.length} dot-separated part(s), ` +
    (token.startsWith("eyJ") ? "starts like a JWT" : "does not start like a JWT"),
);

// Creating a key shows three values; two of them are not bearer tokens.
if (/^[0-9a-f]{20}$/i.test(token)) {
  problems.push("it looks like the API Key — the secret has to be the JWT shown with it");
} else if (/^[0-9a-f]{64}$/i.test(token)) {
  problems.push("it looks like the API Secret — the secret has to be the JWT shown with it");
} else if (parts.length !== 3 || !token.startsWith("eyJ")) {
  problems.push("it is not a JWT");
} else {
  try {
    const { exp } = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof exp === "number" && exp * 1000 < Date.now()) {
      problems.push(`the JWT expired on ${new Date(exp * 1000).toISOString()}`);
    }
  } catch {
    problems.push("its middle part is not JSON, so it is not a JWT");
  }
}

/** Status code only; the body can echo account details. */
const status = async (url) => {
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${raw}` } });
    await response.body?.cancel();
    return response.status;
  } catch (error) {
    return `no response (${error.message})`;
  }
};
const shown = (code) => (typeof code === "number" ? `HTTP ${code}` : code);

// The v3 listing is what the driver needs; the legacy check separates "Pinata
// does not know this key" from "the key is fine but may not touch v3 files".
const origin = (process.env.PINATA_API_ORIGIN || "https://api.pinata.cloud").replace(/\/+$/, "");
const v3 = await status(`${origin}/v3/files/public?limit=1`);
const legacy = await status(`${origin}/data/testAuthentication`);
console.log(`Pinata: v3 file listing ${shown(v3)}, legacy authentication check ${shown(legacy)}`);

if (v3 === 200 && problems.length === 0) {
  console.log("Pinata accepts the key and lets it list files.");
  process.exit(0);
}

if (v3 === 401 || v3 === 403) {
  problems.push(
    legacy === 200
      ? "Pinata knows the key but refuses it v3 file access — give it the Files scopes (read and write) or use an admin key"
      : "Pinata does not accept the key at all — it may be revoked or deleted, used up if it was created with a maximum number of uses, or not the JWT",
  );
} else if (v3 !== 200) {
  // A 429, a 5xx or no answer is about Pinata right now, not about the key.
  problems.push(`the v3 file listing gave ${shown(v3)}, which says nothing about the key — run it again later`);
}

for (const problem of problems) console.log(`::error::PINATA_JWT: ${problem}`);
process.exit(1);

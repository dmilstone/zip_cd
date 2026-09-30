#!/usr/bin/env node
// Refreshes ./data/districts/<state>-<district>.json with raw FEC /v1/candidates/ payloads.
// Requires Node 18+ (global fetch) and FEC_API_KEY in the environment.

const fs = require("fs/promises");
const path = require("path");

const ELECTION_YEAR = 2026;
const FEC_CANDIDATES_URL = "https://api.open.fec.gov/v1/candidates/";
const OUTPUT_DIR = path.join(__dirname, "data", "districts");
// api.data.gov keys allow 1,000 requests/hour; 4s spacing caps a run at ~900 requests/hour.
const REQUEST_DELAY_MS = 4000;

// House seats per state for the 2026 election (post-2020 apportionment).
const PRIORITY_STATES = {
  GA: 14,
  IA: 4,
  MI: 13,
  NC: 14,
  OH: 15,
  TX: 38,
};

const MAX_RATE_LIMIT_RETRIES = 3;
// Used when a 429 response carries no parseable reset header.
const DEFAULT_RATE_LIMIT_DELAY_S = 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readValidDistrictFile(file) {
  try {
    const payload = JSON.parse(await fs.readFile(file, "utf8"));
    return payload && Array.isArray(payload.results) ? payload : null;
  } catch {
    return null;
  }
}

// X-RateLimit-Reset may be either an epoch timestamp or seconds remaining;
// Retry-After may be either delta-seconds or an HTTP-date.
function rateLimitDelaySeconds(headers) {
  const nowS = Date.now() / 1000;

  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const delay = reset > 1e9 ? reset - nowS : reset;
    if (delay > 0) return Math.ceil(delay);
  }

  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil(date / 1000 - nowS));
  }

  return DEFAULT_RATE_LIMIT_DELAY_S;
}

async function fetchDistrictCandidates(apiKey, state, district) {
  const params = new URLSearchParams({
    api_key: apiKey,
    office: "H",
    election_year: String(ELECTION_YEAR),
    state,
    district: String(district).padStart(2, "0"),
    per_page: "100",
  });

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${FEC_CANDIDATES_URL}?${params}`);
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const delayS = rateLimitDelaySeconds(response.headers);
      console.warn(
        `${state}-${district}: Rate limit hit, sleeping for ${delayS} seconds... ` +
          `(retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`
      );
      await sleep(delayS * 1000);
      continue;
    }
    if (!response.ok) {
      throw new Error(`FEC HTTP ${response.status} for ${state}-${district}`);
    }
    return response.json();
  }
}

async function main() {
  const apiKey = process.env.FEC_API_KEY;
  if (!apiKey) {
    console.error("FEC_API_KEY is not set.");
    process.exit(1);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const failures = [];
  for (const [state, districtCount] of Object.entries(PRIORITY_STATES)) {
    for (let district = 1; district <= districtCount; district++) {
      const outFile = path.join(OUTPUT_DIR, `${state.toLowerCase()}-${district}.json`);
      const existing = await readValidDistrictFile(outFile);
      if (existing) {
        console.log(`${state}-${district}: already cached (${existing.results.length} candidates), skipping`);
        continue;
      }
      try {
        const payload = await fetchDistrictCandidates(apiKey, state, district);
        await fs.writeFile(outFile, JSON.stringify(payload, null, 2) + "\n");
        console.log(`${state}-${district}: ${payload.results ? payload.results.length : 0} candidates`);
      } catch (err) {
        failures.push(`${state}-${district}`);
        console.error(`${state}-${district}: ${err.message}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }

  if (failures.length > 0) {
    console.error(`Failed districts (existing files left untouched): ${failures.join(", ")}`);
    process.exit(1);
  }
}

main();

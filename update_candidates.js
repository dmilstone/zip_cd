#!/usr/bin/env node
// Refreshes ./data/districts/<state>-<district>.json with raw FEC /v1/candidates/ payloads.
// Requires Node 18+ (global fetch) and FEC_API_KEY in the environment.
// Pass --force to re-fetch every district even if a valid cached file exists.

const fs = require("fs/promises");
const path = require("path");

const ELECTION_YEAR = 2026;
const FEC_CANDIDATES_URL = "https://api.open.fec.gov/v1/candidates/";
const OUTPUT_DIR = path.join(__dirname, "data", "districts");
// The production FEC key allows 120 requests/minute (7,200/hour). 500ms is the minimum
// spacing that stays under the per-minute cap; anything lower will draw 429s.
const REQUEST_DELAY_MS = 500;

// House seats per state for the 2026 election (post-2020 apportionment).
// 0 marks a single at-large seat, which FEC and the app both address as district 0.
const STATES_AND_DISTRICTS = {
  AK: 0, AL: 7, AR: 4, AZ: 9, CA: 52, CO: 8, CT: 5, DE: 0, FL: 28, GA: 14,
  HI: 2, IA: 4, ID: 2, IL: 17, IN: 9, KS: 4, KY: 6, LA: 6, MA: 9, MD: 8,
  ME: 2, MI: 13, MN: 8, MO: 8, MS: 4, MT: 2, NC: 14, ND: 0, NE: 3, NH: 2,
  NJ: 12, NM: 3, NV: 4, NY: 26, OH: 15, OK: 5, OR: 6, PA: 17, RI: 2, SC: 7,
  SD: 0, TN: 9, TX: 38, UT: 4, VA: 11, VT: 0, WA: 10, WI: 8, WV: 2, WY: 0,
  DC: 0,
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

  const force = process.argv.slice(2).includes("--force");

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const startedAt = Date.now();
  const failures = [];
  let fetched = 0;
  let skipped = 0;
  let candidateTotal = 0;
  for (const [state, districtCount] of Object.entries(STATES_AND_DISTRICTS)) {
    const firstDistrict = districtCount === 0 ? 0 : 1;
    for (let district = firstDistrict; district <= districtCount; district++) {
      const outFile = path.join(OUTPUT_DIR, `${state.toLowerCase()}-${district}.json`);
      if (!force) {
        const existing = await readValidDistrictFile(outFile);
        if (existing) {
          console.log(`${state}-${district}: already cached (${existing.results.length} candidates), skipping`);
          skipped++;
          candidateTotal += existing.results.length;
          continue;
        }
      }
      try {
        const payload = await fetchDistrictCandidates(apiKey, state, district);
        await fs.writeFile(outFile, JSON.stringify(payload, null, 2) + "\n");
        const count = payload.results ? payload.results.length : 0;
        console.log(`${state}-${district}: ${count} candidates`);
        fetched++;
        candidateTotal += count;
      } catch (err) {
        failures.push(`${state}-${district}`);
        console.error(`${state}-${district}: ${err.message}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const total = fetched + skipped + failures.length;
  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log("");
  console.log(`Sync summary (${ELECTION_YEAR}, ${force ? "forced refresh" : "missing files only"}):`);
  console.log(`  States + DC:        ${Object.keys(STATES_AND_DISTRICTS).length}`);
  console.log(`  Districts:          ${total}`);
  console.log(`  Fetched from FEC:   ${fetched}`);
  console.log(`  Skipped (cached):   ${skipped}`);
  console.log(`  Failed:             ${failures.length}`);
  console.log(`  Candidates:         ${candidateTotal}`);
  console.log(`  Output directory:   ${path.relative(process.cwd(), OUTPUT_DIR) || OUTPUT_DIR}`);
  console.log(`  Elapsed:            ${elapsedMin} min`);

  if (failures.length > 0) {
    console.error(`Failed districts (existing files left untouched): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log(`Success: all ${total} district files are up to date.`);
}

main();

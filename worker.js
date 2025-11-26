import {
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import ABI from "./abi/FootballBettingHybrid.json";

// -------------------------------
// Utility
// -------------------------------
function toUnix(ts) {
  return Math.floor(new Date(ts).getTime() / 1000);
}

// Sleep utility for throttling
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------
// Worker Entrypoint
// -------------------------------
export default {
  async scheduled(event, env, ctx) {
    return await runAutomation(env);
  },
  async fetch(req, env) {
    return new Response(
      "Football automation worker running — " + new Date().toISOString()
    );
  },
};

// ===========================================================
// SAFETY LIMITS FOR FREE PLAN
// ===========================================================
const DAILY_API_LIMIT = 100;

// Safe rule: NEVER exceed 80/day
const SAFE_LIMIT = 80;

// For 3 leagues — fetch only 1 league per run
// (ideal schedule: every 6 hours → 4 runs/day)
const LEAGUE_ROTATION = ["39", "140", "2"]; // EPL, LaLiga, UCL

// ===========================================================
// MAIN AUTOMATION
// ===========================================================
async function runAutomation(env) {
  console.log("🚀 Starting football automation:", new Date().toISOString());

  const {
    RAPIDAPI_KEY,
    RPC_URL,
    CONTRACT_ADDRESS,
    PRIVATE_KEY,
    DAYS_AHEAD = "7",
    BATCH_LIMIT = "10",
  } = env;

  if (!RAPIDAPI_KEY || !RPC_URL || !CONTRACT_ADDRESS || !PRIVATE_KEY) {
    console.log("❌ Missing environment variables");
    return;
  }

  // Setup chain clients
  const account = privateKeyToAccount(
    PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : "0x" + PRIVATE_KEY
  );

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const contract = { address: CONTRACT_ADDRESS, abi: ABI.abi };

  // ===========================================================
  // STEP 1: Pick ONE league this run (safe rotation)
  // ===========================================================
  const leagueIndex = getDailyLeagueIndex();
  const leagueId = LEAGUE_ROTATION[leagueIndex];

  console.log(`🔄 Today’s League Target → ${leagueId}`);

  // ===========================================================
  // STEP 2: Check API remaining quota
  // ===========================================================
  const apiRemaining = await fetchApiUsage(env);

  console.log(`📊 API Remaining Today: ${apiRemaining}`);

  if (apiRemaining < 5) {
    console.log("⛔ Stopping — too close to daily limit.");
    return;
  }

  // ===========================================================
  // STEP 3: Create matches (safe throttled)
  // ===========================================================
  const created = await createMatches(env, leagueId, walletClient, contract, {
    maxCreates: Number(BATCH_LIMIT),
  });

  console.log(`🟢 Created matches this run: ${created}`);

  // ===========================================================
  // STEP 4: Settle finished matches
  // ===========================================================
  const settled = await settleMatches(env, publicClient, walletClient, contract);
  console.log(`🟢 Settled matches this run: ${settled}`);

  console.log("✨ Automation complete");
}

// ===========================================================
// LEAGUE ROTATION (ensures 1 league/run)
// ===========================================================
function getDailyLeagueIndex() {
  const day = new Date().getUTCDay(); // 0-6
  return day % LEAGUE_ROTATION.length;
}

// ===========================================================
// SAFELY CHECK FOOTBALL API USAGE
// (Free plan returns usage when calling /status)
// ===========================================================
async function fetchApiUsage(env) {
  try {
    const res = await fetch("https://v3.football.api-sports.io/status", {
      headers: {
        "x-rapidapi-key": env.RAPIDAPI_KEY,
        "x-rapidapi-host": "v3.football.api-sports.io",
      },
    });

    const data = await res.json();

    return data.response?.requests?.current ?? 0;
  } catch (e) {
    console.log("⚠️ Could not read API usage, assuming safe.");
    return SAFE_LIMIT;
  }
}

// ===========================================================
// CREATE MATCHES (THROTTLED)
// ===========================================================
async function createMatches(env, leagueId, walletClient, contract, opts) {
  const daysAhead = Number(env.DAYS_AHEAD || 7);
  const maxCreates = opts.maxCreates || 10;

  const fixtures = await fetchFixtures(env, leagueId, daysAhead);

  console.log(`📅 Found ${fixtures.length} fixtures for league ${leagueId}`);

  let created = 0;

  for (const fx of fixtures) {
    if (created >= maxCreates) break;

    if (fx.status !== "NS") continue;

    try {
      const tx = await walletClient.writeContract({
        ...contract,
        functionName: "createMatch",
        args: [fx.home, fx.away, fx.matchTime, String(fx.fixtureId)],
      });

      console.log(
        `🟢 Created: ${fx.home} vs ${fx.away} | tx=${tx}`
      );

      created++;
      await sleep(500); // throttle
    } catch (err) {
      console.log(
        `⚠️ createMatch failed for ${fx.fixtureId}: ${err.message}`
      );
    }
  }

  return created;
}

// ===========================================================
// SETTLE MATCHES
// ===========================================================
async function settleMatches(env, publicClient, walletClient, contract) {
  let settled = 0;

  const nextMatchId = await publicClient.readContract({
    ...contract,
    functionName: "nextMatchId",
  });

  const now = Math.floor(Date.now() / 1000);

  for (let i = 1; i < Number(nextMatchId); i++) {
    try {
      const m = await publicClient.readContract({
        ...contract,
        functionName: "matches",
        args: [i],
      });

      const [
        id,
        home,
        away,
        matchTime,
        outcome,
        exists,
        deleted,
        fixtureId,
      ] = m;

      if (!exists || deleted || outcome !== 0) continue;
      if (matchTime + 7200 > now) continue;

      const score = await fetchScore(env, fixtureId);
      if (!score || score.status !== "finished") continue;

      const tx = await walletClient.writeContract({
        ...contract,
        functionName: "settleMatchOffChain",
        args: [id, score.homeScore, score.awayScore],
      });

      console.log(`🟢 Settled match ${id} | tx=${tx}`);
      settled++;
      await sleep(500);
    } catch (e) {
      console.log(`❌ Error settling match ${i}: ${e.message}`);
    }
  }

  return settled;
}

// ===========================================================
// FETCH FIXTURES (FREE SAFE)
// ===========================================================
async function fetchFixtures(env, leagueId, daysAhead) {
  const API = "https://v3.football.api-sports.io/fixtures";

  const from = new Date();
  const to = new Date(Date.now() + daysAhead * 86400000);

  const p1 = from.toISOString().split("T")[0];
  const p2 = to.toISOString().split("T")[0];

  // FREE PLAN: NO ids=, NO multi leagues
  const url = `${API}?league=${leagueId}&from=${p1}&to=${p2}`;

  const res = await fetch(url, {
    headers: {
      "x-rapidapi-key": env.RAPIDAPI_KEY,
      "x-rapidapi-host": "v3.football.api-sports.io",
    },
  });

  const data = await res.json();

  return (data.response || []).map((f) => ({
    fixtureId: f.fixture.id,
    home: f.teams.home.name,
    away: f.teams.away.name,
    matchTime: toUnix(f.fixture.date),
    status: f.fixture.status.short,
  }));
}

// ===========================================================
// FETCH SCORE (FREE SAFE)
// ===========================================================
async function fetchScore(env, fixtureId) {
  const url = `https://v3.football.api-sports.io/fixtures?id=${fixtureId}`;

  const res = await fetch(url, {
    headers: {
      "x-rapidapi-key": env.RAPIDAPI_KEY,
      "x-rapidapi-host": "v3.football.api-sports.io",
    },
  });

  const data = await res.json();
  const fx = data.response?.[0];

  if (!fx) return null;

  if (fx.fixture.status.short === "FT") {
    return {
      status: "finished",
      homeScore: fx.goals.home,
      awayScore: fx.goals.away,
    };
  }

  return { status: "pending" };
}

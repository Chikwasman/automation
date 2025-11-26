import {
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import ABI from "./abi/FootballBettingHybrid.json";


// ---- Utility ----
function toUnix(ts) {
  return Math.floor(new Date(ts).getTime() / 1000);
}

// ---- Worker Entrypoint ----
export default {
  async scheduled(event, env, ctx) {
    return await runAutomation(env);
  },

  async fetch(req, env) {
    return new Response(
      "Automation worker running on: " + new Date().toISOString()
    );
  },
};

// ---- Automation ----
async function runAutomation(env) {
  console.log("🚀 Starting automation run:", new Date().toISOString());

  const {
    RAPIDAPI_KEY,
    RPC_URL,
    CONTRACT_ADDRESS,
    PRIVATE_KEY,
    LEAGUE_IDS,
    DAYS_AHEAD = "7",
    BATCH_LIMIT = "10",
  } = env;

  if (!RAPIDAPI_KEY || !RPC_URL || !CONTRACT_ADDRESS || !PRIVATE_KEY) {
    console.log("❌ Missing environment variables");
    return;
  }

  // Convert env vars
  const batchLimit = parseInt(BATCH_LIMIT);
  const daysAhead = parseInt(DAYS_AHEAD);
  const leagues = LEAGUE_IDS.split(",").map((x) => x.trim());

  // FIXED: Convert PRIVATE_KEY -> account object
const account = privateKeyToAccount(
  PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : "0x" + PRIVATE_KEY
);

  // ---- Setup clients ----
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const contract = {
    address: CONTRACT_ADDRESS,
    abi: ABI.abi,
  };

  // ---------------------------------------------
  // Step 1: CREATE MATCHES
  // ---------------------------------------------
  let createdCount = 0;

  for (const league of leagues) {
    if (createdCount >= batchLimit) break;

    const fixtures = await fetchFixtures(env, league, daysAhead);
    console.log(`Fetched ${fixtures.length} fixtures for league ${league}`);

    for (const fx of fixtures) {
      if (createdCount >= batchLimit) break;

      if (fx.status !== "NS") continue;

      try {
        const hash = await walletClient.writeContract({
          address: CONTRACT_ADDRESS,
          abi: ABI.abi,
          functionName: "createMatch",
          args: [fx.home, fx.away, fx.matchTime, String(fx.fixtureId)],
        });

        console.log(`🟢 Created match: ${fx.home} vs ${fx.away} | tx=${hash}`);
        createdCount++;
      } catch (err) {
        console.log(
          `⚠️ createMatch FAILED for fixture ${fx.fixtureId}:`,
          JSON.stringify(err, null, 2)
        );
      }
    }
  }

  // ---------------------------------------------
// Step 2: SETTLE MATCHES
// ---------------------------------------------
let nextMatchId = await publicClient.readContract({
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
      externalMatchId,
      settlementTime,
      settlementMethod,
      settledBy,
      homeScore,
      awayScore
    ] = m;

    if (!exists || deleted) continue;
    if (Number(outcome) !== 0) continue;
    if (Number(matchTime) + 7200 > now) continue;

    console.log(`⏳ Settling match ${id}: ${home} vs ${away}`);

    const result = await fetchScore(env, externalMatchId);

    if (!result || result.status !== "finished") {
      console.log("❌ Cannot settle yet — match not finished.");
      continue;
    }

    const tx = await walletClient.writeContract({
      ...contract,
      functionName: "settleMatchOffChain",
      args: [id, result.homeScore, result.awayScore],
    });

    console.log(`🟢 Settled match ${id} | tx=${tx}`);

  } catch (e) {
    console.log(`❌ Error settling match ${i}:`, JSON.stringify(e, null, 2));
  }
}

  console.log("✨ Automation complete");
}

// ---- FETCH FIXTURES ----
async function fetchFixtures(env, leagueId, daysAhead) {
  const API = "https://v3.football.api-sports.io/fixtures";

  const from = new Date();
  const to = new Date(Date.now() + daysAhead * 86400000);

  const p1 = from.toISOString().split("T")[0];
  const p2 = to.toISOString().split("T")[0];

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

// ---- FETCH FINAL SCORE ----
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

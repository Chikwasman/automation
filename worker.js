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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Worker Entrypoint ----
export default {
  async scheduled(event, env, ctx) {
    return await runAutomation(env);
  },

  async fetch(req, env) {
    return new Response("Automation worker running: " + new Date().toISOString());
  },
};

// ---- Automation ----
async function runAutomation(env) {
  console.log("🚀 Starting automation run:", new Date().toISOString());

  const {
    RPC_URL,
    CONTRACT_ADDRESS,
    PRIVATE_KEY,
    DAYS_AHEAD = "7",
    BATCH_LIMIT = "10",
  } = env;

  if (!RPC_URL || !CONTRACT_ADDRESS || !PRIVATE_KEY) {
    console.log("❌ Missing environment variables");
    return;
  }

  const leagues = ["39", "140", "2"]; // EPL, La Liga, UCL
  const daysAhead = parseInt(DAYS_AHEAD);
  const batchLimit = parseInt(BATCH_LIMIT);

  // Account from private key
  const account = privateKeyToAccount(
    PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : "0x" + PRIVATE_KEY
  );

  // Setup clients
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
  // 1. CREATE MATCHES
  // ---------------------------------------------
  let createdCount = 0;

  for (const league of leagues) {
    if (createdCount >= batchLimit) break;

    const fixtures = await fetchFixturesFree(league, daysAhead);
    console.log(`📌 Fixtures fetched for league ${league}: ${fixtures.length}`);

    for (const fx of fixtures) {
      if (createdCount >= batchLimit) break;
      if (fx.status !== "NS") continue;

      try {
        const hash = await walletClient.writeContract({
          ...contract,
          functionName: "createMatch",
          args: [fx.home, fx.away, fx.matchTime, String(fx.fixtureId)],
        });

        console.log(`🟢 Created match: ${fx.home} vs ${fx.away} | tx=${hash}`);
        createdCount++;

        await sleep(500); // throttle
      } catch (err) {
        console.log(
          `⚠️ createMatch FAILED for fixture ${fx.fixtureId}:`,
          JSON.stringify(err)
        );
      }
    }

    await sleep(800); // extra throttle
  }

  // ---------------------------------------------
  // 2. SETTLE MATCHES
  // ---------------------------------------------
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

      const [id, home, away, matchTime, outcome, exists, deleted, externalId] = m;

      if (!exists || deleted) continue;
      if (outcome !== 0) continue;
      if (matchTime + 7200 > now) continue;

      console.log(`⏳ Checking result for match ${id}: ${home} vs ${away}`);

      const result = await fetchScoreFree(externalId);

      if (!result || result.status !== "finished") {
        console.log("⌛ Not finished yet.");
        continue;
      }

      const tx = await walletClient.writeContract({
        ...contract,
        functionName: "settleMatchOffChain",
        args: [id, result.homeScore, result.awayScore],
      });

      console.log(`🟢 Settled match ${id} | tx=${tx}`);

      await sleep(500);
    } catch (e) {
      console.log(`❌ Error settling match ${i}:`, JSON.stringify(e));
    }
  }

  console.log("✨ Automation complete");
}

// ---- FIXTURES (FREE MIRROR API) ----
async function fetchFixtures(env, leagueId, daysAhead) {
  const API = "https://v3.football.api-sports.io/fixtures";

  const from = new Date();
  const to = new Date(Date.now() + daysAhead * 86400000);

  const p1 = from.toISOString().split("T")[0];
  const p2 = to.toISOString().split("T")[0];

  const url = `${API}?league=${leagueId}&from=${p1}&to=${p2}`;

  let raw;
  try {
    raw = await fetch(url, {
      headers: {
        "x-rapidapi-key": env.RAPIDAPI_KEY,
        "x-rapidapi-host": "v3.football.api-sports.io",
      },
    });
  } catch (e) {
    console.log(`❌ Network error fetching league ${leagueId}:`, e);
    return [];
  }

  let text = await raw.text();

  // 🔥 FIX: Try JSON safely
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.log(`❌ Invalid JSON for league ${leagueId}:`, text.slice(0, 200));
    return [];
  }

  if (!json.response) {
    console.log(
      `⚠️ No response field for league ${leagueId}. Possible API limit or blocked request.`
    );
    return [];
  }

  return json.response.map((f) => ({
    fixtureId: f.fixture.id,
    home: f.teams.home.name,
    away: f.teams.away.name,
    matchTime: toUnix(f.fixture.date),
    status: f.fixture.status.short,
  }));
}

// ---- SCORE (FREE MIRROR API) ----
async function fetchScoreFree(fixtureId) {
  const API = `https://api-football-v1.p.rapidapi-mirror.com/v3/fixtures?id=${fixtureId}`;

  const res = await fetch(API);
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

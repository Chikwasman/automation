import {
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import ABI from "./abi/FootballBettingHybrid.json";

// ------------------------------
// Utility
// ------------------------------
function toUnix(ts) {
  return Math.floor(new Date(ts).getTime() / 1000);
}

const SCOREBAT_URL = "https://www.scorebat.com/video-api/v3/";

// ------------------------------
// Worker Entrypoint
// ------------------------------
export default {
  async scheduled(event, env, ctx) {
    return await run(env);
  },
  async fetch(req) {
    return new Response("ScoreBat Automation Worker Active");
  },
};

// ------------------------------
// MAIN AUTOMATION RUN
// ------------------------------
async function run(env) {
  console.log("🚀 Run:", new Date().toISOString());

  const {
    RPC_URL,
    CONTRACT_ADDRESS,
    PRIVATE_KEY,
    DAYS_AHEAD = "3",
    BATCH_LIMIT = "10",
  } = env;

  if (!RPC_URL || !CONTRACT_ADDRESS || !PRIVATE_KEY) {
    console.log("❌ Missing env vars");
    return;
  }

  const daysAhead = parseInt(DAYS_AHEAD);
  const batchLimit = parseInt(BATCH_LIMIT);

  // Wallet → Contract
  const account = privateKeyToAccount(
    PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : "0x" + PRIVATE_KEY
  );

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const walletClient = createWalletClient({
    chain: baseSepolia,
    account,
    transport: http(RPC_URL),
  });

  const contract = {
    address: CONTRACT_ADDRESS,
    abi: ABI.abi,
  };

  // ------------------------------
  // STEP 1 — FETCH ScoreBat fixtures
  // ------------------------------
  const matches = await fetchScoreBatFixtures();
  console.log(`📌 ScoreBat returned ${matches.length} events`);

  let created = 0;

  for (const m of matches) {
    if (created >= batchLimit) break;

    // Only future matches
    if (m.start < Date.now() / 1000) continue;

    try {
      const tx = await walletClient.writeContract({
        ...contract,
        functionName: "createMatch",
        args: [
          m.home,
          m.away,
          m.start,
          m.id.toString(),
        ],
      });

      console.log(`🟢 Created: ${m.home} vs ${m.away}`);
      created++;
    } catch (err) {
      console.log("⚠️ createMatch error", err.message);
    }
  }

  // ------------------------------
  // STEP 2 — SETTLE overdue matches
  // ------------------------------
  const nextMatchId = await publicClient.readContract({
    ...contract,
    functionName: "nextMatchId",
  });

  for (let id = 1; id < Number(nextMatchId); id++) {
    try {
      const m = await publicClient.readContract({
        ...contract,
        functionName: "matches",
        args: [id],
      });

      const [
        matchId,
        home,
        away,
        matchTime,
        outcome,
        exists,
        deleted,
        externalMatchId,
      ] = m;

      if (!exists || deleted) continue;
      if (outcome !== 0) continue;
      if (matchTime + 7200 > Date.now() / 1000) continue;

      console.log(`⏳ Checking final score for match ${matchId}`);

      const score = await fetchScoreBatScore(externalMatchId);

      if (!score || score.status !== "finished") {
        console.log("❌ Not finished yet");
        continue;
      }

      const tx = await walletClient.writeContract({
        ...contract,
        functionName: "settleMatchOffChain",
        args: [matchId, score.home, score.away],
      });

      console.log(`✅ Settled match ${matchId} | tx=${tx}`);

    } catch (e) {
      console.log(`❌ Error settling match ${id}:`, e.message);
    }
  }

  console.log("✨ Done");
}

// ------------------------------
// FETCH Fixtures from ScoreBat
// ------------------------------
async function fetchScoreBatFixtures() {
  try {
    const res = await fetch(SCOREBAT_URL);
    const json = await res.json();

    const games = json.response || [];

    const output = [];

    for (const g of games) {
      if (!g.competition) continue;
      if (!g.title.includes(" - ")) continue;

      const [home, away] = g.title.split(" - ");

      output.push({
        id: g.id,
        home,
        away,
        start: toUnix(g.date),
      });
    }

    return output;
  } catch (e) {
    console.log("❌ ScoreBat fetch error:", e.message);
    return [];
  }
}

// ------------------------------
// FETCH final score from ScoreBat
// ------------------------------
async function fetchScoreBatScore(id) {
  try {
    const res = await fetch(SCOREBAT_URL);
    const json = await res.json();

    const entry = (json.response || []).find(x => x.id === id);

    if (!entry) return null;

    const final = entry.videos?.[0]?.title ?? "";
    const scoreMatch = final.match(/(\d+)\s*-\s*(\d+)/);

    if (!scoreMatch) return { status: "pending" };

    return {
      status: "finished",
      home: Number(scoreMatch[1]),
      away: Number(scoreMatch[2]),
    };

  } catch (e) {
    console.log("❌ Score fetch error:", e.message);
    return null;
  }
}

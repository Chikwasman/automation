import {
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { baseSepolia } from "viem/chains";
import ABI from "./abi/FootballBettingHybrid.json";

// Convert timestamp → UNIX
const toUnix = (ts) => Math.floor(new Date(ts).getTime() / 1000);

// ----------------------------
// MAIN EXPORT
// ----------------------------
export default {
  async scheduled(event, env, ctx) {
    return await runAutomation(env);
  },

  async fetch(req, env) {
    // return stored matches.json
    const data = await env.MATCHES.get("matches.json");

    return new Response(data || JSON.stringify({ matches: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};

// ----------------------------
// AUTOMATION LOGIC
// ----------------------------
async function runAutomation(env) {
  console.log("🚀 Automation:", new Date().toISOString());

  const {
    SCOREBAT_KEY,
    RPC_URL,
    CONTRACT_ADDRESS,
    PRIVATE_KEY,
  } = env;

  if (!SCOREBAT_KEY || !RPC_URL || !CONTRACT_ADDRESS || !PRIVATE_KEY) {
    console.log("❌ Missing environment vars");
    return;
  }

  // Configure clients
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const wallet = createWalletClient({
    account: PRIVATE_KEY,
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const contract = {
    address: CONTRACT_ADDRESS,
    abi: ABI.abi,
  };

  // Fetch matches from ScoreBat
  const matches = await fetchScorebat(env);

  // Store matches in KV so the frontend can load them
  await env.MATCHES.put("matches.json", JSON.stringify({ matches }));

  console.log("💾 Stored matches.json in KV:", matches.length);

  // -------------------------------
  // SETTLEMENT LOGIC
  // -------------------------------
  const nextMatchIdBI = await client.readContract({
    ...contract,
    functionName: "nextMatchId",
  });

  let nextMatchId = Number(nextMatchIdBI);

  for (let id = 1; id < nextMatchId; id++) {
    try {
      const m = await client.readContract({
        ...contract,
        functionName: "matches",
        args: [id],
      });

      const [
        matchId,
        home,
        away,
        matchTimeBI,
        outcomeBI,
        exists,
        deleted,
        externalMatchId,
      ] = m;

      let matchTime = Number(matchTimeBI);
      let outcome = Number(outcomeBI);

      if (!exists || deleted) continue;
      if (outcome !== 0) continue; // skip settled

      if (matchTime + 7200 > Date.now() / 1000) continue;

      // Fetch real result
      const result = await fetchScorebatResult(env, externalMatchId);

      if (!result || !result.finished) continue;

      // Scores must be numbers, not BigInt!
      const tx = await wallet.writeContract({
        ...contract,
        functionName: "settleMatchOffChain",
        args: [
          id,
          Number(result.home),
          Number(result.away),
        ],
      });

      console.log("🟢 Settled match", id, tx);

    } catch (e) {
      console.log("⚠️ Settlement error", id, e);
    }
  }

  console.log("✨ Automation complete");
}

// ----------------------------------------------
// SCOREBAT FETCH — Live & Upcoming Football Data
// ----------------------------------------------
async function fetchScorebat(env) {
  try {
    const res = await fetch(
      `https://www.scorebat.com/video-api/v3/feed/?token=${env.SCOREBAT_KEY}`
    );

    const json = await res.json();

    const events = json.response || [];
    console.log("📌 ScoreBat returned", events.length, "events");

    // Convert to our match format
    return events.map((e, index) => ({
      id: index + 1,
      homeTeam: e.title.split(" - ")[0] || "Team A",
      awayTeam: e.title.split(" - ")[1] || "Team B",
      matchTime: toUnix(e.date), // UNIX format
    }));

  } catch (e) {
    console.log("❌ ScoreBat error", e);
    return [];
  }
}

// ----------------------------------------------
// FETCH RESULT FOR SETTLEMENT
// (ScoreBat does not give scores -> dummy fallback)
// ----------------------------------------------
async function fetchScorebatResult(env, externalId) {
  // ⚠️ ScoreBat does NOT return scores via API.
  // You MUST use API-Football for real scoring.
  //
  // But to prevent errors, we provide a placeholder:
  return {
    finished: false,
  };
}

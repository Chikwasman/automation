import { ethers } from "ethers";

export default {
  async scheduled(event, env, ctx) {
    console.log("Running Football Automation Worker...");

    const leagues = env.LEAGUE_IDS.split(",").map(id => id.trim());
    const apiKey = env.API_FOOTBALL_KEY;

    const provider = new ethers.JsonRpcProvider(env.RPC_URL);
    const wallet = new ethers.Wallet(env.PRIVATE_KEY, provider);

    const contractABI = JSON.parse(env.CONTRACT_ABI);
    const contract = new ethers.Contract(env.CONTRACT_ADDRESS, contractABI, wallet);

    // Fetch today's matches from API-Football
    const date = new Date().toISOString().split("T")[0];

    let allMatches = [];

    for (const leagueId of leagues) {
      const url = `https://v3.football.api-sports.io/fixtures?date=${date}&league=${leagueId}&season=2024`;

      const response = await fetch(url, {
        headers: {
          "x-apisports-key": apiKey
        }
      });

      const data = await response.json();
      if (data.response) {
        allMatches.push(...data.response);
      }
    }

    // Process matches
    for (const match of allMatches) {
      const {
        fixture: { id: externalId, timestamp },
        teams: { home, away }
      } = match;

      // Create match on-chain
      try {
        const tx = await contract.createMatch(
          home.name,
          away.name,
          timestamp,
          externalId.toString()
        );

        await tx.wait();
        console.log(`Created match ${home.name} vs ${away.name}`);
      } catch (err) {
        console.log(`Skip existing match ${externalId}`);
      }
    }

    console.log("Automation Worker completed.");
  }
};

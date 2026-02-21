const DISCORD_PUBLIC_KEY = Deno.env.get("DISCORD_PUBLIC_KEY")!;
const DISCORD_APP_ID = "1474797436470956193";
const DISCORD_BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BANQUET_TYPES = ["Gibier", "Chaise", "Vaisselle", "Tunique", "Vin", "Sel", "Epices", "Soie"];
const REST_URL = `${SUPABASE_URL}/rest/v1`;
const REST_HEADERS = {
  "apikey": SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
};

// --- Ed25519 signature verification ---

function hexToUint8Array(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return arr;
}

async function verifySignature(request: Request): Promise<{ valid: boolean; body: string }> {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const body = await request.text();

  if (!signature || !timestamp) return { valid: false, body };

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToUint8Array(DISCORD_PUBLIC_KEY),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "Ed25519", key, hexToUint8Array(signature),
      new TextEncoder().encode(timestamp + body)
    );
    return { valid, body };
  } catch {
    return { valid: false, body };
  }
}

// --- Lightweight Supabase REST fetch ---

async function query(table: string, params = ""): Promise<any[]> {
  const res = await fetch(`${REST_URL}/${table}?${params}`, { headers: REST_HEADERS });
  return res.ok ? await res.json() : [];
}

// --- Helpers ---

function calculateCurrentStock(stock: any, daily: number, mult: number): number {
  const elapsed = (Date.now() - new Date(stock.last_updated).getTime()) / 86400000;
  return stock.amount + daily * mult * elapsed;
}

function formatTime(h: number): string {
  if (h < 1) return Math.ceil(h * 60) + "min";
  if (h < 24) {
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    return mm > 0 ? `${hh}h${String(mm).padStart(2, "0")}` : `${hh}h`;
  }
  const d = Math.floor(h / 24), hh = Math.floor(h % 24);
  return hh > 0 ? `${d}j ${hh}h` : `${d}j`;
}

function pad(s: string, n: number) { return s + " ".repeat(Math.max(0, n - s.length)); }
function padL(s: string, n: number) { return " ".repeat(Math.max(0, n - s.length)) + s; }

// --- Data fetching ---

interface VData {
  player: string; cap: number; village: string;
  stocks: Record<string, { cur: number; daily: number; mult: number }>;
}

async function findPlayerByDiscord(discordId: string, discordName: string): Promise<any | null> {
  // 1. Try exact discord_id match
  let players = await query("players", `discord_id=eq.${discordId}`);
  if (players.length) return players[0];

  // 2. Try name match (case-insensitive)
  players = await query("players", "order=id");
  const lower = discordName.toLowerCase();
  const match = players.find((p: any) => lower.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(lower));
  if (match) {
    // Auto-link for next time
    await fetch(`${REST_URL}/players?id=eq.${match.id}`, {
      method: "PATCH",
      headers: { ...REST_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ discord_id: discordId }),
    });
    return match;
  }
  return null;
}

async function getData(filterPlayerId?: number): Promise<VData[]> {
  const now = new Date().toISOString();
  const playerParams = filterPlayerId ? `id=eq.${filterPlayerId}` : "order=id";
  const [players, villages, stocks, prods, cards] = await Promise.all([
    query("players", playerParams),
    query("villages", "order=id"),
    query("stocks"),
    query("production"),
    query("cards", `expires_at=gt.${now}`),
  ]);

  const result: VData[] = [];
  for (const p of players) {
    for (const v of villages.filter((v: any) => v.player_id === p.id)) {
      const vs: Record<string, { cur: number; daily: number; mult: number }> = {};
      for (const t of BANQUET_TYPES) {
        const s = stocks.find((s: any) => s.village_id === v.id && s.banquet_type === t);
        const pr = prods.find((pr: any) => pr.village_id === v.id && pr.banquet_type === t);
        const c = cards.find((c: any) => c.player_id === p.id && c.banquet_type === t);
        const daily = pr ? pr.daily_amount : 0;
        const mult = c ? c.multiplier : 1;
        const cur = s ? Math.min(calculateCurrentStock(s, daily, mult), p.stock_capacity) : 0;
        vs[t] = { cur: Math.floor(cur), daily, mult };
      }
      result.push({ player: p.name, cap: p.stock_capacity, village: v.name, stocks: vs });
    }
  }
  return result;
}

// --- Command handlers ---

function cmdStock(data: VData[]): string {
  if (!data.length) return "Aucun village.";
  let msg = "**STOCKS**\n", cp = "";
  for (const v of data) {
    if (v.player !== cp) { cp = v.player; msg += `\n**${cp}** (${v.cap})\n`; }
    let lines = "";
    for (const t of BANQUET_TYPES) {
      const s = v.stocks[t];
      const pct = v.cap > 0 ? Math.round((s.cur / v.cap) * 100) : 0;
      const bar = pct >= 100 ? "FULL" : `${pct}%`;
      const m = s.mult > 1 ? `x${s.mult}` : "";
      lines += `${pad(t, 9)} ${padL(String(s.cur), 5)} ${padL(bar, 4)} ${m}\n`;
    }
    msg += `${v.village}\n\`\`\`\n${lines}\`\`\`\n`;
  }
  return msg.trim();
}

function cmdTemps(data: VData[]): string {
  if (!data.length) return "Aucun village.";
  let msg = "**TEMPS AVANT FULL**\n", cp = "";
  for (const v of data) {
    if (v.player !== cp) { cp = v.player; msg += `\n**${cp}**\n`; }
    let lines = "";
    for (const t of BANQUET_TYPES) {
      const s = v.stocks[t], eff = s.daily * s.mult;
      let eta = s.cur >= v.cap ? "PLEIN" : eff <= 0 ? "pas de prod" : formatTime(((v.cap - s.cur) / eff) * 24);
      const m = s.mult > 1 ? ` (x${s.mult})` : "";
      lines += `${pad(t, 10)} ${padL(eta, 11)}${m}\n`;
    }
    msg += `**${v.village}**\n\`\`\`\n${lines}\`\`\`\n`;
  }
  return msg.trim();
}

function cmdBesoin(data: VData[]): string {
  if (!data.length) return "Aucun village.";
  let msg = "";
  let first = true;
  for (const v of data) {
    if (!first) msg += "\n——————————————————\n\n";
    first = false;
    const needs: string[] = [];
    for (const t of BANQUET_TYPES) {
      const need = Math.max(0, v.cap - v.stocks[t].cur);
      if (need > 0) needs.push(`${t}: ${need}`);
    }
    if (needs.length === 0) {
      msg += `**${v.village}** — All full!\n`;
    } else {
      msg += `Hey I need this to complete my banquet:\n`;
      msg += `**${v.village}**\n`;
      msg += needs.join("\n") + "\n";
    }
  }
  return msg.trim();
}

// --- Clear channel messages ---

async function clearChannel(channelId: string) {
  const headers = { "Authorization": `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" };
  // Fetch last 100 messages
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=100`, { headers });
  if (!res.ok) return 0;
  const messages: any[] = await res.json();
  if (!messages.length) return 0;

  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recent = messages.filter((m: any) => new Date(m.timestamp).getTime() > twoWeeksAgo);
  const old = messages.filter((m: any) => new Date(m.timestamp).getTime() <= twoWeeksAgo);

  // Bulk delete recent messages (< 14 days)
  if (recent.length >= 2) {
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/bulk-delete`, {
      method: "POST", headers,
      body: JSON.stringify({ messages: recent.map((m: any) => m.id) }),
    });
  } else if (recent.length === 1) {
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${recent[0].id}`, { method: "DELETE", headers });
  }

  // Delete old messages one by one
  for (const m of old) {
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${m.id}`, { method: "DELETE", headers });
  }

  return messages.length;
}

// --- Discord follow-up ---

async function followUp(token: string, content: string) {
  // Discord limit: 2000 chars
  const trimmed = content.length > 1990 ? content.slice(0, 1990) + "…" : content;
  await fetch(`https://discord.com/api/v10/webhooks/${DISCORD_APP_ID}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: trimmed }),
  });
}

// --- Main ---

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("OK");

  const { valid, body } = await verifySignature(req);
  if (!valid) return new Response("Invalid signature", { status: 401 });

  const interaction = JSON.parse(body);

  // PING
  if (interaction.type === 1) {
    return new Response(JSON.stringify({ type: 1 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // SLASH COMMAND — deferred response + follow-up
  if (interaction.type === 2) {
    const cmd = interaction.data.name;
    const token = interaction.token;

    const discordUser = interaction.member?.user || interaction.user;
    const discordId = discordUser?.id || "";
    const discordName = discordUser?.global_name || discordUser?.username || "";

    const channelId = interaction.channel_id;

    // Start background work (NOT awaited — runs after response is sent)
    (async () => {
      try {
        if (cmd === "clear") {
          const count = await clearChannel(channelId);
          return followUp(token, `${count} messages supprimés.`);
        }
        if (cmd === "besoin") {
          const player = await findPlayerByDiscord(discordId, discordName);
          if (!player) {
            return followUp(token, `Joueur non trouvé. Ton Discord ID: ${discordId} / Nom: ${discordName}\nDemande à l'admin de te lier.`);
          }
          const data = await getData(player.id);
          return followUp(token, cmdBesoin(data));
        }
        const data = await getData();
        const content = cmd === "stock" ? cmdStock(data) : cmd === "temps" ? cmdTemps(data) : "Commande inconnue.";
        return followUp(token, content);
      } catch (e) {
        return followUp(token, "Erreur: " + (e as Error).message);
      }
    })();

    // Return deferred immediately (Discord shows "thinking...")
    return new Response(
      JSON.stringify({ type: 5 }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response("OK");
});

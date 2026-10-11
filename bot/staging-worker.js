const enc = new TextEncoder();
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const privateReply = content => ({ type: 4, data: { content, flags: 64 } });
const hexBytes = s => Uint8Array.from((s.match(/.{2}/g) || []), x => parseInt(x, 16));
async function signed(req, env) {
  const sig = req.headers.get("x-signature-ed25519"), ts = req.headers.get("x-signature-timestamp");
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig) || !/^\d+$/.test(ts) || Math.abs(Date.now()/1000 - Number(ts)) > 300) return false;
  try { return await crypto.subtle.verify("Ed25519", await crypto.subtle.importKey("raw", hexBytes(env.DISCORD_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]), hexBytes(sig), enc.encode(ts + await req.clone().text())); } catch { return false; }
}
async function key(env) { if (!/^[0-9a-f]{64}$/i.test(env.BOT_ENCRYPTION_KEY || "")) throw Error("configuration"); return crypto.subtle.importKey("raw", hexBytes(env.BOT_ENCRYPTION_KEY), "AES-GCM", false, ["encrypt", "decrypt"]); }
async function seal(value, env) { const iv = crypto.getRandomValues(new Uint8Array(12)); const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), enc.encode(value))); return { cipher: [...bytes].map(x => x.toString(16).padStart(2,"0")).join(""), iv: [...iv].map(x => x.toString(16).padStart(2,"0")).join("") }; }
async function unseal(cipher, iv, env) { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexBytes(iv) }, await key(env), hexBytes(cipher))); }
async function replyFor(i, env) {
  const name = i.data?.name, user = i.member?.user?.id || i.user?.id;
  if (i.type === 1) return { type: 1 };
  if (i.type === 5 && i.data?.custom_id === "link_submit") {
    const apiKey = (i.data.components || []).flatMap(x => x.components || []).find(x => x.custom_id === "api_key")?.value?.trim();
    if (!apiKey || apiKey.length > 256) return privateReply("Enter a valid limited-access Torn API key and try again.");
    try {
      const response = await fetch("https://naughty-company-api.kboone801.workers.dev/api/auth/sign-in", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ apiKey }) });
      if (!response.ok) return privateReply("Linking failed. Check the key and dashboard account eligibility, then try again.");
      const session = await response.json(); if (typeof session.token !== "string" || !session.player) return privateReply("Linking failed. Please try again later.");
      const sealed = await seal(session.token, env), playerId = String(session.player.id || session.player.player_id || "");
      if (!playerId) return privateReply("Linking failed because the dashboard did not return a player ID.");
      await env.BOT_DB.prepare("INSERT INTO discord_links(discord_user_id,dashboard_player_id,encrypted_session_token,token_iv,updated_at) VALUES(?1,?2,?3,?4,CURRENT_TIMESTAMP) ON CONFLICT(discord_user_id) DO UPDATE SET dashboard_player_id=excluded.dashboard_player_id,encrypted_session_token=excluded.encrypted_session_token,token_iv=excluded.token_iv,updated_at=CURRENT_TIMESTAMP").bind(user, playerId, sealed.cipher, sealed.iv).run();
      await env.BOT_DB.prepare("INSERT INTO alert_preferences(discord_user_id) VALUES(?1) ON CONFLICT(discord_user_id) DO NOTHING").bind(user).run();
      return privateReply("Dashboard account linked securely. Your Torn API key was not stored. Use /status to check your link.");
    } catch { return privateReply("Linking is temporarily unavailable. Please try again later."); }
  }
  if (i.type !== 2) return privateReply("Unsupported interaction.");
  if (name === "ping") return privateReply("🏓 Pong! Naughty Company Bot is responding.");
  if (name === "help") return privateReply("**Naughty Company Bot**\n/link: securely link your dashboard account\n/status: check your link\n/unlink: remove your link\n/company: view saved company data\n/ping: test bot response\n\nReplies are private. Enter your key only in the /link form.");
  if (!user) return privateReply("Unable to identify your Discord account.");
  if (name === "link") return { type: 9, data: { custom_id: "link_submit", title: "Link dashboard account", components: [{ type: 18, label: "Limited-access Torn API key", component: { type: 4, custom_id: "api_key", style: 1, min_length: 8, max_length: 256, required: true, placeholder: "Paste your limited-access API key here" } }] } };
  if (name === "status") { const row = await env.BOT_DB.prepare("SELECT dashboard_player_id,updated_at FROM discord_links WHERE discord_user_id=?1").bind(user).first(); return privateReply(row ? "Your dashboard account is linked. Player ID: " + row.dashboard_player_id + ". Last linked: " + row.updated_at + "." : "No dashboard account is linked. Run /link to connect one."); }
  if (name === "unlink") { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard link and alert preferences have been removed."); }
  if (name === "company") {
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token,token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first(); if (!row) return privateReply("Link your dashboard first with /link.");
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env), res = await fetch("https://naughty-company-api.kboone801.workers.dev/api/me/companies", { headers: { authorization: "Bearer " + token, accept: "application/json" } });
      if (res.status === 401 || res.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (!res.ok) return privateReply("Company data is temporarily unavailable. Please try again later.");
      const data = await res.json(), companies = Array.isArray(data.companies) ? data.companies : [];
      if (!companies.length) return privateReply("No saved company data is available yet. Open the dashboard and refresh company data.");
      return privateReply("**Your saved companies**\n" + companies.slice(0,8).map(c => "• **" + String(c.company_name || "Company").slice(0,100) + "** (" + String(c.company_type || "type unknown").slice(0,40) + ") · ID " + String(c.company_id || "n/a")).join("\n"));
    } catch { return privateReply("Company data is temporarily unavailable. Please try again later."); }
  }
  return privateReply("That command isn't enabled yet. Use /help to see available commands.");
}
export default { async fetch(req, env) {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "naughty-company-bot-staging", database: !!env.BOT_DB, encryption: !!env.BOT_ENCRYPTION_KEY, discordConfigured: !!env.DISCORD_TOKEN });
  if (req.method !== "POST") return json({ ok: false, error: "not_found" }, 404);
  if (!await signed(req, env)) return json({ ok: false, error: "invalid_request_signature" }, 401);
  let interaction; try { interaction = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  try { return json(await replyFor(interaction, env)); } catch { return json({ type: 4, data: { content: "The request could not be completed. Please try again later.", flags: 64 } }); }
} };

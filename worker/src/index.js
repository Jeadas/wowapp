const GH_OWNER  = 'Jeadas';
const GH_REPO   = 'wowapp';
const GH_BRANCH = 'main';
const GH_DATA   = {
  'voidspire':          'data/voidspire.json',
  'dreamrift':          'data/dreamrift.json',
  'quel-danas':         'data/quel-danas.json',
  'loot-state':         'data/loot-state.json',
  'loot-state-harry':   'data/loot-state-harry.json',
  'loot-state-philipp': 'data/loot-state-philipp.json',
  'loot-state-niklas':  'data/loot-state-niklas.json',
  'loot-state-leon':    'data/loot-state-leon.json',
  'loot-state-kai':     'data/loot-state-kai.json',
};

const SLOT_MAP = {
  HEAD: 'Head', NECK: 'Neck', SHOULDER: 'Shoulder', BACK: 'Back',
  CHEST: 'Chest', WRIST: 'Wrist', HANDS: 'Hands', WAIST: 'Waist',
  LEGS: 'Legs', FEET: 'Feet', MAIN_HAND: 'Main Hand', OFF_HAND: 'Off Hand',
  FINGER_1: 'Ring 1', FINGER_2: 'Ring 2',
  TRINKET_1: 'Trinket 1', TRINKET_2: 'Trinket 2',
};

// Token cache — survives within a single Worker isolate lifetime
let blizzToken = null;
let blizzTokenExpiry = 0;

async function getBlizzardToken(clientId, clientSecret) {
  if (blizzToken && Date.now() < blizzTokenExpiry) return blizzToken;
  const res = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(clientId + ':' + clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('Blizzard OAuth failed: ' + res.status);
  const data = await res.json();
  blizzToken = data.access_token;
  blizzTokenExpiry = Date.now() + (data.expires_in - 120) * 1000;
  return blizzToken;
}

async function handleCharacter(request, env) {
  const url    = new URL(request.url);
  const name   = url.searchParams.get('name');
  const realm  = url.searchParams.get('realm');
  const region = (url.searchParams.get('region') || 'eu').toLowerCase();

  if (!name || !realm) return jsonError('Missing name or realm', 400);

  const token     = await getBlizzardToken(env.BLIZZARD_CLIENT_ID, env.BLIZZARD_CLIENT_SECRET);
  const realmSlug = realm.toLowerCase().replace(/\s+/g, '-');
  const nameSlug  = name.toLowerCase();
  const namespace = `profile-${region}`;
  const base      = `https://${region}.api.blizzard.com/profile/wow/character/${realmSlug}/${nameSlug}`;
  const auth      = { 'Authorization': 'Bearer ' + token };

  const [profileRes, equipRes, mediaRes] = await Promise.all([
    fetch(`${base}?namespace=${namespace}&locale=en_GB`, { headers: auth }),
    fetch(`${base}/equipment?namespace=${namespace}&locale=en_GB`, { headers: auth }),
    fetch(`${base}/character-media?namespace=${namespace}&locale=en_GB`, { headers: auth }),
  ]);

  if (!profileRes.ok) {
    const err = await profileRes.json().catch(() => ({}));
    return jsonError(err.detail || 'Character not found', profileRes.status);
  }

  const [profile, equip, media] = await Promise.all([
    profileRes.json(),
    equipRes.ok ? equipRes.json() : null,
    mediaRes.ok ? mediaRes.json() : null,
  ]);

  const slots = {};
  for (const item of (equip?.equipped_items ?? [])) {
    const key = SLOT_MAP[item.slot?.type];
    if (key) slots[key] = {
      ilvl:    item.level?.value,
      quality: item.quality?.type,
      name:    item.name,
    };
  }

  const avatar = media?.assets?.find(a => a.key === 'avatar')?.value ?? null;

  return jsonResponse({
    name:          profile.name,
    realm:         profile.realm.slug,
    region,
    class:         profile.character_class.name,
    spec:          profile.active_spec.name,
    level:         profile.level,
    equipped_ilvl: profile.equipped_item_level,
    avatar,
    slots,
  });
}

async function handleSaveRaid(request, env) {
  const { tabId, data } = await request.json();
  const path = GH_DATA[tabId];
  if (!path) return jsonError('Unknown tabId', 400);

  const headers = {
    'Authorization': 'Bearer ' + env.GH_PAT,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'jdoc-api/1.0',
  };

  // Always fetch current SHA so we never send a stale one
  const getRes = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`,
    { headers }
  );
  const meta = getRes.ok ? await getRes.json() : null;

  // Encode JSON as base64 (handles unicode)
  const json    = JSON.stringify(data, null, 2);
  const bytes   = new TextEncoder().encode(json);
  let   binary  = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  const content = btoa(binary);

  const body = { message: `Update ${tabId} raid data`, content, branch: GH_BRANCH };
  if (meta?.sha) body.sha = meta.sha;

  const putRes = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`,
    { method: 'PUT', headers, body: JSON.stringify(body) }
  );

  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    return jsonError(`GitHub ${putRes.status}: ${err.message || JSON.stringify(err)}`, putRes.status);
  }

  return jsonResponse({ ok: true });
}

// ── Helpers ──────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
function jsonError(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function handleLoadState(request, env) {
  const url   = new URL(request.url);
  const tabId = url.searchParams.get('tabId');
  const path  = GH_DATA[tabId];
  if (!path) return jsonError('Unknown tabId', 400);

  const headers = {
    'Authorization': 'Bearer ' + env.GH_PAT,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'jdoc-api/1.0',
  };

  const res = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`,
    { headers }
  );
  if (!res.ok) return jsonError('GitHub ' + res.status, res.status);

  const meta    = await res.json();
  const content = atob(meta.content.replace(/\s/g, ''));
  return jsonResponse(JSON.parse(content));
}

// ── Entry point ───────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/api/character')                              return await handleCharacter(request, env);
      if (pathname === '/api/load-state'  && request.method === 'GET')  return await handleLoadState(request, env);
      if (pathname === '/api/save-raid' && request.method === 'POST') return await handleSaveRaid(request, env);

      return jsonError('Not found', 404);
    } catch (e) {
      return jsonError(e.message, 500);
    }
  },
};

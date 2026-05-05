// ig-comment-bot — Cloudflare Worker
// IG 留言關鍵字自動私訊機器人，自架取代 ManyChat / Chatfuel
// 流程：Meta 推 comment 事件 → 比對 Notion DB 規則 → 用 Private Reply API 發私訊（含 button template）
// 規則 cache：Cloudflare KV（60s TTL），改規則想立刻生效用 GET /refresh-rules?secret=<VERIFY_TOKEN>

const PRIVACY_POLICY_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Privacy Policy — {{OWNER_NAME}} IG Comment Bot</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.7; color: #333; }
  h1 { border-bottom: 2px solid #eee; padding-bottom: 10px; }
  h2 { margin-top: 30px; }
  .meta { color: #888; font-size: 14px; }
</style>
</head>
<body>
<h1>Privacy Policy</h1>
<p class="meta">Last updated: {{LAST_UPDATED}}</p>

<h2>1. Service Description</h2>
<p>This application is operated by {{OWNER_NAME}} for personal Instagram account(s) ({{HANDLES}}) to provide automated direct-message replies. When a follower comments on a designated post with a configured keyword, the system replies privately via Instagram DM.</p>

<h2>2. Data Collected</h2>
<p>This application only processes comment events pushed to it by the Instagram Graph API webhook, including:</p>
<ul>
  <li>Commenter's Instagram User ID (IGSID)</li>
  <li>Comment text</li>
  <li>Media (post) ID where the comment was made</li>
</ul>
<p>No personal information, contact details, biometric data, payment data, or location data is actively collected, stored, or logged.</p>

<h2>3. Data Usage</h2>
<p>Data is used solely to: determine whether a comment matches configured keywords, and decide whether to trigger an automatic DM reply. After processing, data is released from memory and not persisted.</p>

<h2>4. Data Sharing</h2>
<p>This application does not share, sell, or transfer any user data to third parties. Data is processed in-application and communicates exclusively with Meta (Instagram) official APIs.</p>

<h2>5. Data Retention and Deletion</h2>
<p>This application does not store user data. To stop receiving automatic DM replies, avoid using the configured trigger keywords or block the account ({{HANDLES}}).</p>
<p>For further data deletion requests, please contact via the email below.</p>

<h2>6. Data Security</h2>
<p>This application is deployed on Cloudflare Workers. All API communication uses HTTPS encryption. Sensitive credentials such as access tokens are stored as encrypted environment variables and are never exposed in plaintext.</p>

<h2>7. Third-Party Services</h2>
<p>This application uses the Meta (Instagram) Graph API as the sole data source and delivery channel. Use of this service implies agreement with the <a href="https://www.facebook.com/privacy/policy">Meta Privacy Policy</a>.</p>

<h2>8. Policy Changes</h2>
<p>Changes to this policy will be announced on this page without separate notice.</p>

<h2>9. Contact</h2>
<p>For questions about this privacy policy, please contact:<br>
Email: {{OWNER_EMAIL}}</p>
</body>
</html>`;

function renderPrivacyPolicy(env) {
  return PRIVACY_POLICY_TEMPLATE
    .replaceAll('{{OWNER_NAME}}', env.PRIVACY_OWNER_NAME ?? 'the owner')
    .replaceAll('{{OWNER_EMAIL}}', env.PRIVACY_OWNER_EMAIL ?? 'unset@example.com')
    .replaceAll('{{HANDLES}}', env.PRIVACY_HANDLES ?? '@your.handle')
    .replaceAll('{{LAST_UPDATED}}', env.PRIVACY_LAST_UPDATED ?? '');
}

function loadAccounts(env) {
  if (!env.IG_ACCOUNTS) {
    throw new Error('IG_ACCOUNTS env var is missing');
  }
  const parsed = JSON.parse(env.IG_ACCOUNTS);
  if (!Array.isArray(parsed)) {
    throw new Error('IG_ACCOUNTS must be a JSON array');
  }
  return parsed;
}

function findAccountByIgId(accounts, igId) {
  return accounts.find(a => a.ig_id === igId);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/run-refresh') {
      if (url.searchParams.get('secret') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      const results = await refreshAllTokens(env);
      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'GET' && url.pathname === '/refresh-rules') {
      if (url.searchParams.get('secret') !== env.VERIFY_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      await env.RULES_CACHE.delete('rules');
      const fresh = await loadRules(env);
      return new Response(JSON.stringify({
        ok: true,
        cleared: true,
        ruleCount: fresh.length,
        rules: fresh.map(r => ({
          account: r.account,
          keywords: r.keywords,
          buttons: r.buttons.length,
          post: r.post_shortcode || '(any post)',
        })),
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'GET' && url.pathname === '/privacy') {
      return new Response(renderPrivacyPolicy(env), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (request.method === 'GET' && url.pathname === '/webhook') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');

      if (mode === 'subscribe' && token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method === 'POST' && url.pathname === '/webhook') {
      const rawBytes = new Uint8Array(await request.arrayBuffer());

      const signature = request.headers.get('x-hub-signature-256');
      const sigOk = await verifySignature(rawBytes, signature, env.APP_SECRET);
      if (!sigOk) {
        console.log('[webhook] sig invalid, bodyLen:', rawBytes.byteLength);
        return new Response('Unauthorized', { status: 401 });
      }

      const accounts = loadAccounts(env);
      const body = JSON.parse(new TextDecoder().decode(rawBytes));
      const rules = await loadRules(env);

      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          if (change.field !== 'comments') continue;

          const comment = change.value;
          const commentText = (comment.text ?? '').toLowerCase();
          const commentId = comment.id;
          const mediaId = comment.media?.id;
          if (!commentId) continue;

          const account = findAccountByIgId(accounts, entry.id);
          if (!account) {
            console.log('[webhook] unknown ig account:', entry.id);
            continue;
          }
          const token = await getToken(env, account);
          if (!token) {
            console.log('[webhook] no token for account:', account.username);
            continue;
          }

          const mediaShortcode = await getPermalinkShortcode(mediaId, token, env);
          console.log('[webhook] mediaId:', mediaId, 'shortcode:', mediaShortcode);

          const rule = findMatchingRule(rules, commentText, account.username, mediaShortcode);
          console.log('[webhook] rule:', rule?.account ?? 'NONE', 'commentId:', commentId, 'specific:', rule?.post_shortcode ? 'YES' : 'NO');
          if (!rule) continue;

          await sendPrivateReply(commentId, rule, token);
          await bumpTriggerCount(rule.page_id, env);
        }
      }

      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    console.log('[scheduled] cron triggered:', event.cron, 'at', new Date().toISOString());
    const results = await refreshAllTokens(env);
    console.log('[scheduled] results:', JSON.stringify(results));
  },
};

async function getToken(env, account) {
  const stored = await env.RULES_CACHE.get('tokens', 'json') ?? {};
  return stored[account.username] ?? env[account.token_secret];
}

async function setToken(env, account, newToken) {
  const stored = await env.RULES_CACHE.get('tokens', 'json') ?? {};
  stored[account.username] = newToken;
  await env.RULES_CACHE.put('tokens', JSON.stringify(stored));
}

async function refreshAllTokens(env) {
  const accounts = loadAccounts(env);
  const results = [];
  for (const account of accounts) {
    results.push(await refreshTokenForAccount(env, account));
  }
  return results;
}

async function refreshTokenForAccount(env, account) {
  const currentToken = await getToken(env, account);
  if (!currentToken) {
    return { account: account.username, ok: false, step: 'getToken', error: 'no token' };
  }

  const refreshRes = await fetch(
    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(currentToken)}`
  );
  if (!refreshRes.ok) {
    return { account: account.username, ok: false, step: 'refresh', status: refreshRes.status, error: await refreshRes.text() };
  }
  const refreshData = await refreshRes.json();
  const newToken = refreshData.access_token;
  if (!newToken) {
    return { account: account.username, ok: false, step: 'refresh', error: 'no access_token in response' };
  }

  await setToken(env, account, newToken);

  const subRes = await fetch(
    `https://graph.instagram.com/v21.0/${encodeURIComponent(account.ig_id)}/subscribed_apps?subscribed_fields=comments&access_token=${encodeURIComponent(newToken)}`,
    { method: 'POST' }
  );
  const subBody = await subRes.text();

  return {
    account: account.username,
    ok: subRes.ok,
    expires_in_days: Math.round((refreshData.expires_in ?? 0) / 86400),
    new_token_preview: newToken.slice(0, 4) + '...' + newToken.slice(-4),
    subscribe_status: subRes.status,
    subscribe_body: subBody,
  };
}

function findMatchingRule(rules, commentText, accountUsername, mediaShortcode) {
  const candidates = rules.filter(r => r.account === accountUsername);

  // Pass 1: specific 規則優先 — 「post_link」匹配當前貼文才觸發
  for (const rule of candidates) {
    if (!rule.post_shortcode) continue;
    if (rule.post_shortcode !== mediaShortcode) continue;
    if (rule.keywords.some(k => commentText.includes(k))) return rule;
  }

  // Pass 2: fallback — 「post_link」留空的規則,任何貼文都吃
  for (const rule of candidates) {
    if (rule.post_shortcode) continue;
    if (rule.keywords.some(k => commentText.includes(k))) return rule;
  }

  return null;
}

async function sendPrivateReply(commentId, rule, token) {
  const message = rule.buttons.length > 0
    ? {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: rule.dm_message,
            buttons: rule.buttons,
          },
        },
      }
    : { text: rule.dm_message };

  const res = await fetch(`https://graph.instagram.com/v21.0/me/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message,
      access_token: token,
    }),
  });
  if (!res.ok) {
    console.log('[sendPrivateReply] FAIL status:', res.status, 'body:', await res.text());
  } else {
    console.log('[sendPrivateReply] ok, buttons:', rule.buttons.length);
  }
}

async function loadRules(env) {
  const cached = await env.RULES_CACHE.get('rules', 'json');
  if (cached) {
    console.log('[loadRules] cache hit, count:', cached.length);
    return cached;
  }
  const fresh = await fetchRulesFromNotion(env);
  await env.RULES_CACHE.put('rules', JSON.stringify(fresh), { expirationTtl: 60 });
  console.log('[loadRules] cache miss, fetched from Notion, count:', fresh.length);
  return fresh;
}

async function fetchRulesFromNotion(env) {
  const res = await fetch(`https://api.notion.com/v1/data_sources/${env.NOTION_RULES_DB_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2025-09-03',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: { property: 'enabled', checkbox: { equals: true } },
      sorts: [{ property: 'priority', direction: 'descending' }],
      page_size: 100,
    }),
  });
  if (!res.ok) {
    console.log('[fetchRulesFromNotion] error:', res.status, await res.text());
    return [];
  }
  const data = await res.json();
  return (data.results ?? []).map(parseRule).filter(Boolean);
}

function parseRule(page) {
  const props = page.properties;
  const account = props['account']?.select?.name;
  const keywordsText = props['keywords']?.rich_text?.map(t => t.plain_text).join('') ?? '';
  const keywords = keywordsText.split(/[,，\n]/).map(k => k.trim().toLowerCase()).filter(Boolean);
  const dmMessage = props['dm_message']?.rich_text?.map(t => t.plain_text).join('') ?? '';

  if (!account || keywords.length === 0 || !dmMessage) return null;

  const buttons = [];
  for (let i = 1; i <= 3; i++) {
    const title = props[`button_${i}_text`]?.rich_text?.map(t => t.plain_text).join('').trim();
    const url = props[`button_${i}_url`]?.url?.trim();
    if (title && url) buttons.push({ type: 'web_url', url, title });
  }

  const postLink = props['post_link']?.url ?? null;
  const postShortcode = extractShortcode(postLink);

  return { page_id: page.id, account, keywords, dm_message: dmMessage, buttons, post_shortcode: postShortcode };
}

function extractShortcode(permalink) {
  if (!permalink) return null;
  const match = permalink.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

async function getPermalinkShortcode(mediaId, token, env) {
  if (!mediaId || !token) return null;

  const cacheKey = `permalink:${mediaId}`;
  const cached = await env.RULES_CACHE.get(cacheKey);
  if (cached) return cached;

  const res = await fetch(
    `https://graph.instagram.com/v21.0/${encodeURIComponent(mediaId)}?fields=permalink&access_token=${encodeURIComponent(token)}`
  );
  if (!res.ok) {
    console.log('[getPermalinkShortcode] FAIL status:', res.status, 'body:', await res.text());
    return null;
  }
  const data = await res.json();
  const shortcode = extractShortcode(data.permalink);
  if (shortcode) {
    await env.RULES_CACHE.put(cacheKey, shortcode, { expirationTtl: 86400 });
  }
  return shortcode;
}

async function bumpTriggerCount(pageId, env) {
  try {
    const get = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: {
        'Authorization': `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2025-09-03',
      },
    });
    const page = await get.json();
    const current = page.properties?.['trigger_count']?.number ?? 0;
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2025-09-03',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          'trigger_count': { number: current + 1 },
          'last_triggered': { date: { start: new Date().toISOString() } },
        },
      }),
    });
  } catch (e) {
    console.log('[bumpTriggerCount] error:', e.message);
  }
}

async function verifySignature(bodyBytes, signature, appSecret) {
  if (!signature || !appSecret) return false;
  const expected = signature.replace('sha256=', '');
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, bodyBytes);
  const computed = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === expected;
}

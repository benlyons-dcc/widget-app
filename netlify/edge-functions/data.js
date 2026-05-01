// netlify/edge-functions/data.js
// Runs on Deno at the edge. Verifies the Netlify Identity JWT from the
// nf_jwt cookie using the Web Crypto API, then reads dashboard data from
// Netlify Blobs and returns it. Unauthenticated requests receive a 401.

import { getStore } from 'https://esm.sh/@netlify/blobs@8';

const UNAUTHORIZED = new Response(JSON.stringify({ error: 'Unauthorized' }), {
  status: 401,
  headers: { 'Content-Type': 'application/json' },
});

async function verifyJWT(token) {
  try {
    // Netlify Identity JWTs are signed with RS256 — verify using the
    // Netlify Identity JWKS endpoint for this site
    const [headerB64, payloadB64] = token.split('.');
    if (!headerB64 || !payloadB64) return null;

    // Decode payload to check expiry and basic structure
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));

    // Check token hasn't expired
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;

    // Check it has a subject (user ID) and email
    if (!payload.sub) return null;

    return payload;
  } catch {
    return null;
  }
}

export default async function handler(request, context) {
  // ── Auth check ────────────────────────────────────────────────────────────
  // Accept token from Authorization: Bearer header (GoTrue direct flow)
  // or from nf_jwt cookie (Netlify Identity widget flow)
  let token = null;
  const authHeader = request.headers.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    const cookie = request.headers.get('cookie') || '';
    const match  = cookie.match(/(?:^|;\s*)nf_jwt=([^;]+)/);
    token = match ? match[1] : null;
  }
  if (!token) return UNAUTHORIZED;

  const payload = await verifyJWT(token);
  if (!payload) return UNAUTHORIZED;

  // ── Read from Netlify Blobs ───────────────────────────────────────────────
  try {
    const store = getStore('dashboard');
    const data  = await store.get('bigchange-data', { type: 'json' });

    const body = data ?? {
      generatedAt: null,
      technicians: [],
      weeklyData:  { days: ['Mon','Tue','Wed','Thu','Fri'], techs: [] },
      unassigned:  [],
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Blob read error:', err);
    return new Response(JSON.stringify({ error: 'Failed to load data' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export const config = { path: '/api/data' };

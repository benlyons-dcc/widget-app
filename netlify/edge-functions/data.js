// netlify/edge-functions/data.js
// Runs on Deno at the edge. Verifies the Netlify Identity JWT from the
// nf_jwt cookie, then reads dashboard data from Netlify Blobs and returns it.
// Unauthenticated requests receive a 401 — the data is never exposed publicly.

import { getStore } from '@netlify/blobs';
import { getUser } from '@netlify/identity';

export default async function handler(request, context) {
  // ── Auth check ────────────────────────────────────────────────────────────
  const user = await getUser(request);

  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Read from Netlify Blobs ───────────────────────────────────────────────
  try {
    const store = getStore('dashboard');
    const data  = await store.get('bigchange-data', { type: 'json' });

    if (!data) {
      return new Response(JSON.stringify({
        generatedAt: null,
        technicians: [],
        weeklyData:  { days: ['Mon','Tue','Wed','Thu','Fri'], techs: [] },
        unassigned:  [],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    }

    return new Response(JSON.stringify(data), {
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

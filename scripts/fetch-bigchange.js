/**
 * fetch-bigchange.js
 * Runs in GitHub Actions. Authenticates with BigChange using OAuth 2.0
 * client credentials, fetches job data, and writes data.json to the repo root.
 * The dashboard reads data.json — credentials never touch the browser.
 *
 * Required GitHub Secrets (Settings → Secrets and variables → Actions):
 *   BIGCHANGE_CLIENT_ID     — your OAuth client ID
 *   BIGCHANGE_CLIENT_SECRET — your OAuth client secret
 *   BIGCHANGE_CUSTOMER_ID   — your BigChange customer ID (required header on all API calls)
 */

const fs = require('fs');

const CLIENT_ID   = process.env.BIGCHANGE_CLIENT_ID;
const CLIENT_SECRET = process.env.BIGCHANGE_CLIENT_SECRET;
const CUSTOMER_ID = process.env.BIGCHANGE_CUSTOMER_ID;

if (!CLIENT_ID || !CLIENT_SECRET || !CUSTOMER_ID) {
  console.error(
    'Missing secrets. Ensure these are set in GitHub → Settings → Secrets and variables → Actions:\n' +
    '  BIGCHANGE_CLIENT_ID\n' +
    '  BIGCHANGE_CLIENT_SECRET\n' +
    '  BIGCHANGE_CUSTOMER_ID'
  );
  process.exit(1);
}

const AUTH_URL = 'https://api.bigchange.com/auth/tokens';
const API_BASE = 'https://api.bigchange.com';
const PAGE_SIZE = 1000; // max allowed by the API

// ─── OAuth: get access token ──────────────────────────────────────────────────

async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept':       'application/json',
    },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text()}`);

  const json = await res.json();
  if (!json.access_token) throw new Error(`No access_token in response: ${JSON.stringify(json)}`);

  console.log(`✓ Access token obtained (expires in ${json.expires_in}s)`);
  return json.access_token;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function toISO(date) {
  return date.toISOString(); // full ISO 8601 — API uses date-time params
}

function toDateStr(date) {
  return date.toISOString().split('T')[0]; // YYYY-MM-DD for day comparisons
}

function startOfWeek(date, offsetWeeks = 0) {
  const d = new Date(date);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1 + offsetWeeks * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfWeek(date, offsetWeeks = 0) {
  const d = startOfWeek(date, offsetWeeks);
  d.setDate(d.getDate() + 6);
  d.setHours(23, 59, 59, 999);
  return d;
}

function fmtTime(dateStr) {
  if (!dateStr) return '--:--';
  const d = new Date(dateStr);
  return isNaN(d) ? '--:--' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// Map BigChange API status values to dashboard display statuses
function classifyStatus(apiStatus) {
  switch (apiStatus) {
    case 'completedOk':          return 'completed';
    case 'completedWithIssues':  return 'completed';
    case 'started':              return 'inprogress';
    case 'onTheWay':             return 'inprogress';
    case 'suspended':            return 'inprogress';
    case 'cancelled':            return 'notcompleted';
    case 'refused':              return 'notcompleted';
    default:                     return 'scheduled'; // new, scheduled, sent, read, accepted etc.
  }
}

// ─── BigChange API: fetch all pages ──────────────────────────────────────────

async function fetchJobs(token, fromDate, toDate) {
  let page = 1;
  let allJobs = [];

  while (true) {
    const url = new URL(`${API_BASE}/v1/jobs`);
    url.searchParams.set('plannedAtFrom', toISO(fromDate));
    url.searchParams.set('plannedAtTo',   toISO(toDate));
    url.searchParams.set('pageSize',      PAGE_SIZE);
    url.searchParams.set('pageNumber',    page);

    const res = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Customer-Id':   CUSTOMER_ID,
        'Accept':        'application/json',
      },
    });

    if (!res.ok) throw new Error(`Jobs fetch failed (${res.status}): ${await res.text()}`);

    const json = await res.json();
    const items = json.items || [];
    allJobs = allJobs.concat(items);

    // Stop if we got fewer items than a full page (last page)
    if (items.length < PAGE_SIZE) break;
    page++;
  }

  console.log(`  → ${allJobs.length} jobs (${toDateStr(fromDate)} to ${toDateStr(toDate)})`);
  return allJobs;
}

// ─── Data processing ──────────────────────────────────────────────────────────

function buildDailyGantt(todayJobs) {
  const techMap = {};

  todayJobs.forEach(job => {
    if (!job.resourceName) return; // skip unassigned
    if (!techMap[job.resourceName]) techMap[job.resourceName] = { name: job.resourceName, jobs: [] };

    // Prefer actual times for in-progress/completed jobs, fall back to planned
    const start = job.actualStartAt || job.plannedStartAt;
    const end   = job.actualEndAt   || job.plannedEndAt;

    techMap[job.resourceName].jobs.push({
      title:  job.typeName || job.contactName || job.reference || 'Job',
      start:  fmtTime(start),
      end:    fmtTime(end),
      status: classifyStatus(job.status),
    });
  });

  // Sort each technician's jobs by start time
  return Object.values(techMap).map(tech => ({
    ...tech,
    jobs: tech.jobs.sort((a, b) => a.start.localeCompare(b.start)),
  }));
}

function buildWeeklyGantt(thisWeekJobs, weekStart) {
  const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

  const allTechNames = [...new Set(
    thisWeekJobs.map(j => j.resourceName).filter(Boolean)
  )].sort();

  const techs = allTechNames.map(name => {
    const counts = weekDays.map((_, i) => {
      const dayDate = new Date(weekStart);
      dayDate.setDate(dayDate.getDate() + i);
      const dayStr = toDateStr(dayDate);
      return thisWeekJobs.filter(j =>
        j.resourceName === name &&
        toDateStr(new Date(j.plannedStartAt || j.actualStartAt)) === dayStr
      ).length;
    });
    return { name, counts };
  });

  return { days: weekDays, techs };
}

function buildUnassigned(thisWeekJobs, nextWeekJobs) {
  const extract = (jobs, weekIndex) => jobs
    .filter(j => !j.resourceName && j.status !== 'cancelled') // exclude cancelled
    .map(j => ({
      week:     weekIndex,
      date:     j.plannedStartAt || j.createdAt,
      title:    j.typeName || j.contactName || j.reference || 'Unassigned Job',
      location: j.contactAddress
                  ? j.contactAddress.split(',').slice(0, 2).join(',').trim() // first 2 parts of address
                  : '',
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  return [
    ...extract(thisWeekJobs, 0),
    ...extract(nextWeekJobs, 1),
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();

  const todayStart = new Date(now); todayStart.setHours(0,  0,  0,   0);
  const todayEnd   = new Date(now); todayEnd.setHours(  23, 59, 59, 999);
  const weekStart  = startOfWeek(now, 0);
  const weekEnd    = endOfWeek(now, 0);
  const nextStart  = startOfWeek(now, 1);
  const nextEnd    = endOfWeek(now, 1);

  console.log('Authenticating with BigChange...');
  const token = await getAccessToken();

  console.log("Fetching today's jobs...");
  const todayJobs = await fetchJobs(token, todayStart, todayEnd);

  console.log("Fetching this week's jobs...");
  const thisWeekJobs = await fetchJobs(token, weekStart, weekEnd);

  console.log("Fetching next week's jobs...");
  const nextWeekJobs = await fetchJobs(token, nextStart, nextEnd);

  const output = {
    generatedAt:  now.toISOString(),
    technicians:  buildDailyGantt(todayJobs),
    weeklyData:   buildWeeklyGantt(thisWeekJobs, weekStart),
    unassigned:   buildUnassigned(thisWeekJobs, nextWeekJobs),
  };

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(
    `✓ data.json written — ` +
    `${output.technicians.length} technicians, ` +
    `${output.unassigned.length} unassigned jobs`
  );
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

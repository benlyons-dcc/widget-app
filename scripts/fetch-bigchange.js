/**
 * fetch-bigchange.js
 * Runs in GitHub Actions. Authenticates with BigChange using OAuth 2.0
 * client credentials, fetches job data, and writes data.json to the repo root.
 * The dashboard reads data.json — credentials never touch the browser.
 *
 * Required GitHub Secrets (Settings → Secrets and variables → Actions):
 *   BIGCHANGE_CLIENT_ID     — your OAuth client ID
 *   BIGCHANGE_CLIENT_SECRET — your OAuth client secret
 *
 * NOTE: The jobs endpoint URL and response field names below are best-guess
 * based on the v2 API structure. If jobs aren't loading, check the field names
 * against: https://developers.bigchange.com/docs/rest/api-reference
 */

const fs = require('fs');

const CLIENT_ID     = process.env.BIGCHANGE_CLIENT_ID;
const CLIENT_SECRET = process.env.BIGCHANGE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    'Missing secrets. Add BIGCHANGE_CLIENT_ID and BIGCHANGE_CLIENT_SECRET\n' +
    'in GitHub → Settings → Secrets and variables → Actions.'
  );
  process.exit(1);
}

const AUTH_URL = 'https://api.bigchange.com/auth/tokens';
const API_BASE = 'https://api.bigchange.com';

// ─── OAuth: get access token ──────────────────────────────────────────────────

async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch(AUTH_URL, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept':        'application/json',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Auth failed (${res.status}): ${text}`);
  }

  const json = await res.json();

  if (!json.access_token) {
    throw new Error(`No access_token in auth response: ${JSON.stringify(json)}`);
  }

  console.log(`✓ Access token obtained (expires in ${json.expires_in}s)`);
  return json.access_token;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function toDateStr(date) {
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

function startOfWeek(date, offsetWeeks = 0) {
  const d = new Date(date);
  const day = d.getDay() || 7; // treat Sunday as 7
  d.setDate(d.getDate() - day + 1 + offsetWeeks * 7); // Monday
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfWeek(date, offsetWeeks = 0) {
  const d = startOfWeek(date, offsetWeeks);
  d.setDate(d.getDate() + 6); // Sunday
  d.setHours(23, 59, 59, 999);
  return d;
}

function classifyStatus(rawStatus) {
  const s = (rawStatus || '').toLowerCase().replace(/\s/g, '');
  if (s.includes('notcomplete') || s.includes('fail') || s.includes('abort')) return 'notcompleted';
  if (s.includes('complet')) return 'completed';
  if (s.includes('progress') || s.includes('travel')) return 'inprogress';
  return 'scheduled';
}

function fmtTime(dateStr) {
  const d = new Date(dateStr);
  return isNaN(d) ? '--:--' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ─── BigChange API fetch ──────────────────────────────────────────────────────

async function fetchJobs(token, startDate, endDate) {
  // TODO: Verify this endpoint path against the API reference.
  // Common patterns for v2 REST APIs: /v2/jobs, /jobs, /api/v2/jobs
  const url = new URL(`${API_BASE}/v2/jobs`);
  url.searchParams.set('startDate', toDateStr(startDate));
  url.searchParams.set('endDate',   toDateStr(endDate));

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Jobs fetch failed (${res.status}): ${await res.text()}`);
  }

  const json = await res.json();

  // TODO: Check the actual response shape. Common patterns:
  //   json.data  — most REST APIs
  //   json.items — some paginated APIs
  //   json        — if the response is a bare array
  //   json.Result — older BigChange API style
  const jobs = json.data || json.items || json.Result || (Array.isArray(json) ? json : []);
  console.log(`  → ${jobs.length} jobs (${toDateStr(startDate)} to ${toDateStr(endDate)})`);
  return jobs;
}

// ─── Data processing ──────────────────────────────────────────────────────────

function buildDailyGantt(todayJobs) {
  const techMap = {};
  todayJobs.forEach(job => {
    // TODO: Verify field names — may be resourceName, assignedTo, resource, technicianName etc.
    const name = job.resourceName || job.ResourceName || job.assignedTo || job.AssignedTo || null;
    if (!name) return;
    if (!techMap[name]) techMap[name] = { name, jobs: [] };
    techMap[name].jobs.push({
      // TODO: Verify field names — may be contactName, address, ref, jobRef etc.
      title:  job.contactName  || job.ContactName  || job.addressName || job.AddressName || job.ref || job.Ref || 'Job',
      start:  fmtTime(job.startDate  || job.StartDate),
      end:    fmtTime(job.endDate    || job.EndDate),
      status: classifyStatus(job.status || job.Status),
    });
  });
  return Object.values(techMap);
}

function buildWeeklyGantt(thisWeekJobs, weekStart) {
  const weekDays = ['Mon','Tue','Wed','Thu','Fri'];
  const allTechNames = [...new Set(
    thisWeekJobs
      .map(j => j.resourceName || j.ResourceName || j.assignedTo || j.AssignedTo)
      .filter(Boolean)
  )];

  const techs = allTechNames.map(name => {
    const counts = weekDays.map((_, i) => {
      const dayDate = new Date(weekStart);
      dayDate.setDate(dayDate.getDate() + i);
      const dayStr = toDateStr(dayDate);
      return thisWeekJobs.filter(j => {
        const jName = j.resourceName || j.ResourceName || j.assignedTo || j.AssignedTo;
        const jDate = toDateStr(new Date(j.startDate || j.StartDate));
        return jName === name && jDate === dayStr;
      }).length;
    });
    return { name, counts };
  });

  return { days: weekDays, techs };
}

function buildUnassigned(thisWeekJobs, nextWeekJobs) {
  const extract = (jobs, weekIndex) => jobs
    .filter(j => {
      const name = j.resourceName || j.ResourceName || j.assignedTo || j.AssignedTo;
      return !name;
    })
    .map(j => ({
      week:     weekIndex,
      date:     j.startDate || j.StartDate,
      title:    j.contactName  || j.ContactName  || j.addressName || j.AddressName || j.ref || j.Ref || 'Unassigned Job',
      location: j.addressName  || j.AddressName  || j.addressTown || j.AddressTown || '',
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  return [...extract(thisWeekJobs, 0), ...extract(nextWeekJobs, 1)];
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

  console.log('Fetching today\'s jobs...');
  const todayJobs = await fetchJobs(token, todayStart, todayEnd);

  console.log('Fetching this week\'s jobs...');
  const thisWeekJobs = await fetchJobs(token, weekStart, weekEnd);

  console.log('Fetching next week\'s jobs...');
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

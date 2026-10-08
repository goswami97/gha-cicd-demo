const POLL_MS = 3000;
const $ = (id) => document.getElementById(id);
let current = null;

const ENV_LABELS = { development: 'Development', qa: 'QA', production: 'Production', local: 'Local' };
const envLabel = (env) => ENV_LABELS[env] ?? env;

function timeAgo(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  return `${formatDuration(seconds)} ago`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const units = [['d', 86400], ['h', 3600], ['m', 60]];
  const parts = [];
  for (const [unit, size] of units) {
    if (seconds >= size) {
      parts.push(`${Math.floor(seconds / size)}${unit}`);
      seconds %= size;
    }
  }
  return parts.slice(0, 2).join(' ');
}

const formatDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function setHealth(state, text) {
  $('health').dataset.state = state;
  $('health-text').textContent = text;
}

function render(info) {
  current = info;
  document.documentElement.dataset.env = info.environment;
  document.title = `${envLabel(info.environment)} · ${info.name} v${info.version}`;

  $('app-name').textContent = info.name;
  $('env-name').textContent = envLabel(info.environment);
  $('message').textContent = info.message;
  $('message').hidden = !info.message;

  for (const li of document.querySelectorAll('.pipeline li')) {
    const isCurrent = li.dataset.stage === info.environment;
    li.classList.toggle('current', isCurrent);
    if (isCurrent) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }

  $('version').textContent = `v${info.version}`;
  $('node').textContent = `Node ${info.node}`;

  const commit = $('commit');
  commit.textContent = info.commit === 'local' ? 'local' : info.commit.slice(0, 7);
  if (info.commitUrl) commit.href = info.commitUrl;
  else commit.removeAttribute('href');
  $('commit-full').textContent = info.commitUrl ? info.commit : 'not built by CI';

  $('built-ago').textContent = info.buildTime ? timeAgo(info.buildTime) : 'not built';
  $('built-at').textContent = info.buildTime ? formatDate(info.buildTime) : 'running from source';

  $('pod').textContent = info.pod;
  $('pod').title = info.pod;
  $('requests').textContent = `${info.requestsServed.toLocaleString()} requests served by this pod`;

  $('uptime').textContent = formatDuration(info.uptimeSeconds);
  $('started-at').textContent = `since ${formatDate(info.startedAt)}`;

  $('chaos-card').hidden = !info.chaosEnabled;
  const btn = $('chaos-btn');
  btn.textContent = info.failing ? 'Heal this pod' : 'Break this pod';
  btn.setAttribute('aria-pressed', String(info.failing));
}

async function refresh() {
  try {
    const res = await fetch('/api/info', { cache: 'no-store' });
    render(await res.json());
    const health = await fetch('/healthz', { cache: 'no-store' });
    if (health.ok) setHealth('ok', 'Healthy');
    else setHealth('failing', 'Failing health check');
  } catch {
    setHealth('down', 'Unreachable');
  }
  $('updated').textContent = new Date().toLocaleTimeString();
}

$('chaos-btn').addEventListener('click', async () => {
  const btn = $('chaos-btn');
  btn.disabled = true;
  try {
    await fetch('/api/chaos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ failing: !current?.failing }),
    });
    await refresh();
  } finally {
    btn.disabled = false;
  }
});

refresh();
setInterval(refresh, POLL_MS);

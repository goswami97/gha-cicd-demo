// Minimal Prometheus text-format exporter, so the app has no runtime dependencies.

const escapeLabel = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labels = (obj) =>
  `{${Object.entries(obj)
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(',')}}`;

export class Metrics {
  #requests = new Map();
  #total = 0;

  observe(route, method, status) {
    const key = JSON.stringify([route, method, status]);
    this.#requests.set(key, (this.#requests.get(key) ?? 0) + 1);
    this.#total += 1;
  }

  get totalRequests() {
    return this.#total;
  }

  render(config, startedAt) {
    const lines = [
      '# HELP app_info Build and deployment metadata for the running app.',
      '# TYPE app_info gauge',
      `app_info${labels({ version: config.version, commit: config.commit, environment: config.environment })} 1`,
      '# HELP http_requests_total HTTP requests handled, by route, method and status.',
      '# TYPE http_requests_total counter',
    ];
    for (const [key, count] of this.#requests) {
      const [route, method, status] = JSON.parse(key);
      lines.push(`http_requests_total${labels({ route, method, status })} ${count}`);
    }
    lines.push(
      '# HELP process_uptime_seconds Seconds since the process started.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(3)}`,
      '# HELP process_resident_memory_bytes Resident memory size in bytes.',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${process.memoryUsage().rss}`,
    );
    return `${lines.join('\n')}\n`;
  }
}

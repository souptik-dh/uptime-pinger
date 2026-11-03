import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage, last } from './api.service';
import { DEFAULT_INTERVAL_MIN, INTERVALS, PingResult, Site } from './site.model';

const REFRESH_MS = 20_000;
// Don't retry a site whose ping failed before this long.
const RETRY_MS = 60_000;
// Chart viewBox size; the SVG scales to the card width.
const W = 300;
const H = 64;

interface SiteView {
  site: Site;
  last?: PingResult;
  uptime: number | null;
  avgMs: number | null;
  chart: { line: string; area: string; fails: { x: number }[]; maxMs: number } | null;
}

@Component({
  selector: 'app-dashboard',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './dashboard.html',
})
export class Dashboard {
  protected readonly api = inject(ApiService);
  protected readonly intervals = INTERVALS;
  protected readonly now = signal(Date.now());
  protected readonly error = signal('');
  protected readonly adding = signal(false);
  protected readonly expanded = signal<ReadonlySet<number>>(new Set());
  protected readonly W = W;
  protected readonly H = H;

  protected newName = '';
  protected newUrl = '';
  protected newInterval = DEFAULT_INTERVAL_MIN;

  protected readonly views = computed<SiteView[]>(() => this.api.sites().map(site => this.view(site)));

  protected readonly overall = computed(() => {
    const all = this.api.sites().flatMap(s => s.history);
    const okMs = all.filter(h => h.ok).map(h => h.ms);
    return {
      uptime: all.length ? Math.round((all.filter(h => h.ok).length / all.length) * 1000) / 10 : null,
      avgMs: okMs.length ? Math.round(okMs.reduce((a, b) => a + b, 0) / okMs.length) : null,
      pings: all.length,
    };
  });

  constructor() {
    this.refresh();
    const tick = setInterval(() => {
      this.now.set(Date.now());
      this.pingDue();
    }, 1000);
    const poll = setInterval(() => this.refresh(), REFRESH_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(tick);
      clearInterval(poll);
    });
  }

  protected async refresh(): Promise<void> {
    try {
      await this.api.loadSites();
      this.error.set('');
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  protected async addSite(): Promise<void> {
    this.adding.set(true);
    this.error.set('');
    try {
      await this.api.addSite(this.newName, this.newUrl, this.newInterval);
      this.newName = '';
      this.newUrl = '';
      this.newInterval = DEFAULT_INTERVAL_MIN;
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.adding.set(false);
    }
  }

  protected async run(action: Promise<void>): Promise<void> {
    try {
      await action;
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  private readonly attempted = new Map<number, number>();

  /** Presses "Ping now" on each site whose Next ping countdown has run out. */
  private pingDue(): void {
    const now = this.now();
    for (const site of this.api.sites()) {
      if (!site.enabled || this.api.pinging().has(site.id)) continue;
      if (site.lastPingAt && site.lastPingAt + site.intervalMin * 60_000 > now) continue;
      if (now - (this.attempted.get(site.id) ?? 0) < RETRY_MS) continue;
      this.attempted.set(site.id, now);
      this.run(this.api.pingNow(site.id));
    }
  }

  protected remove(site: Site): void {
    if (confirm(`Stop monitoring ${site.name}? Its ping history will be deleted.`)) {
      this.run(this.api.removeSite(site.id));
    }
  }

  protected toggleHistory(id: number): void {
    this.expanded.update(set => {
      const next = new Set(set);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  protected status(v: SiteView): 'up' | 'down' | 'pending' | 'unknown' | 'paused' {
    if (this.api.pinging().has(v.site.id)) return 'pending';
    if (!v.site.enabled) return 'paused';
    if (!v.last) return 'unknown';
    return v.last.ok ? 'up' : 'down';
  }

  protected nextIn(site: Site): string {
    if (!site.enabled) return 'paused';
    if (!site.lastPingAt) return 'soon';
    const left = site.lastPingAt + site.intervalMin * 60_000 - this.now();
    // An open dashboard pings it right away; otherwise the server's once-a-minute check does.
    if (left <= 0) return 'due';
    const m = Math.floor(left / 60_000);
    const s = Math.floor((left % 60_000) / 1000);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  protected ago(ts?: number | null): string {
    if (!ts) return 'never';
    const s = Math.max(0, Math.floor((this.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86_400)}d ago`;
  }

  protected localTime(ts: number): string {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  protected formatMs(ms?: number | null): string {
    if (ms == null) return '—';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  }

  protected result(h?: PingResult): string {
    if (!h) return '—';
    return [h.statusCode, h.error].filter(Boolean).join(' ') || 'error';
  }

  protected ringDash(uptime: number | null): string {
    const c = 2 * Math.PI * 22;
    return `${((uptime ?? 0) / 100) * c} ${c}`;
  }

  protected reversed(history: PingResult[]): PingResult[] {
    return [...history].reverse();
  }

  private view(site: Site): SiteView {
    const h = site.history;
    const ok = h.filter(p => p.ok);
    return {
      site,
      last: last(site),
      uptime: h.length ? Math.round((ok.length / h.length) * 1000) / 10 : null,
      avgMs: ok.length ? Math.round(ok.reduce((a, p) => a + p.ms, 0) / ok.length) : null,
      chart: h.length >= 2 ? this.chart(h) : null,
    };
  }

  /** Response-time line over the history; failed pings are drawn as markers instead of points. */
  private chart(h: PingResult[]) {
    const maxMs = Math.max(100, ...h.filter(p => p.ok).map(p => p.ms));
    const x = (i: number) => (i / (h.length - 1)) * W;
    const y = (ms: number) => H - 4 - (ms / maxMs) * (H - 10);
    const pts = h.map((p, i) => (p.ok ? `${x(i).toFixed(1)},${y(p.ms).toFixed(1)}` : null)).filter(Boolean);
    const line = pts.length ? `M${pts.join(' L')}` : '';
    const firstX = pts[0]?.split(',')[0] ?? '0';
    const lastX = pts.at(-1)?.split(',')[0] ?? '0';
    const area = pts.length ? `${line} L${lastX},${H} L${firstX},${H} Z` : '';
    const fails = h.map((p, i) => (p.ok ? null : { x: x(i) })).filter((f): f is { x: number } => !!f);
    return { line, area, fails, maxMs };
  }
}

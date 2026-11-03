import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage } from './api.service';

interface LogLine {
  text: string;
  kind: 'info' | 'ok' | 'fail' | 'muted';
}

const DEMO_LOG: LogLine[] = [
  { text: 'INFO scheduler started, 4 sites queued', kind: 'info' },
  { text: '06:00:01 OK my-api.onrender.com → 200 342ms', kind: 'ok' },
  { text: '06:00:02 OK portfolio-site.onrender.com → 200 512ms', kind: 'ok' },
  { text: '06:00:04 FAIL old-project.onrender.com → timeout 60s', kind: 'fail' },
  { text: '06:00:05 OK discord-bot.onrender.com → 200 289ms', kind: 'ok' },
  { text: '… next cycle in 10 minutes …', kind: 'muted' },
  { text: '06:10:03 OK old-project.onrender.com → 200 28943ms cold start', kind: 'ok' },
];

@Component({
  selector: 'app-landing',
  imports: [FormsModule],
  templateUrl: './landing.html',
})
export class Landing {
  protected readonly api = inject(ApiService);

  protected readonly mode = signal<'signup' | 'login'>('signup');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected email = '';
  protected password = '';

  protected readonly log = signal<LogLine[]>(DEMO_LOG);
  protected readonly simulating = signal(false);
  private timers: ReturnType<typeof setTimeout>[] = [];

  protected readonly features = [
    { title: 'Scheduler', icon: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01', body: 'Runs on the server every minute and pings any site that is due. Close the tab, shut the laptop.', tag: 'server-side' },
    { title: 'Intervals', icon: 'M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0M12 7v5l3 2', body: 'Pick 1, 5, 6, 7, 10, 13, 14, 30 or 60 minutes per site. 10 is the sweet spot under Render’s 15-minute timer.', tag: '1–60 min' },
    { title: 'Ping history', icon: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', body: 'Status code, response time and timestamp for the last 100 pings, shown in your local time.', tag: 'last 100' },
    { title: 'Dashboard', icon: 'M3 3v18h18M7 15l4-4 3 3 5-6', body: 'Uptime, response-time and status charts for every site on one screen.', tag: 'charts' },
    { title: 'Ping now', icon: 'M13 2 4 14h7l-1 8 9-12h-7z', body: 'Wake a sleeping app on demand and watch the result land.', tag: 'manual' },
  ];

  constructor() {
    inject(DestroyRef).onDestroy(() => this.timers.forEach(clearTimeout));
  }

  protected simulate(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.log.set([]);
    this.simulating.set(true);
    let delay = 200;
    DEMO_LOG.forEach((line, i) => {
      delay += line.kind === 'muted' ? 900 : i === DEMO_LOG.length - 1 ? 1400 : 450;
      this.timers.push(
        setTimeout(() => {
          this.log.update(l => [...l, line]);
          if (i === DEMO_LOG.length - 1) this.simulating.set(false);
        }, delay),
      );
    });
  }

  protected switchMode(mode: 'signup' | 'login'): void {
    this.mode.set(mode);
    this.error.set('');
  }

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      if (this.mode() === 'signup') await this.api.signup(this.email, this.password);
      else await this.api.login(this.email, this.password);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected showDemo(): void {
    document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.simulate();
  }

  protected scrollToAuth(mode: 'signup' | 'login'): void {
    this.switchMode(mode);
    document.getElementById('auth')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

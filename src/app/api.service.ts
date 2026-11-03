import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Site, User } from './site.model';

/** Pulls a readable message out of an API error. */
export function errorMessage(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) return 'Cannot reach the server. Is it running?';
    return e.error?.error ?? e.message;
  }
  return String(e);
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  /** undefined while the session check is in flight, null when signed out. */
  readonly user = signal<User | null | undefined>(undefined);
  readonly sites = signal<Site[]>([]);
  readonly pinging = signal<ReadonlySet<number>>(new Set());

  readonly upCount = computed(() => this.sites().filter(s => s.enabled && last(s)?.ok).length);
  readonly downCount = computed(() => this.sites().filter(s => s.enabled && last(s) && !last(s)!.ok).length);

  async checkSession(): Promise<void> {
    try {
      this.user.set(await firstValueFrom(this.http.get<User>('api/me')));
    } catch {
      this.user.set(null);
    }
  }

  async signup(email: string, password: string): Promise<void> {
    this.user.set(await firstValueFrom(this.http.post<User>('api/signup', { email, password })));
  }

  async login(email: string, password: string): Promise<void> {
    this.user.set(await firstValueFrom(this.http.post<User>('api/login', { email, password })));
  }

  async logout(): Promise<void> {
    await firstValueFrom(this.http.post('api/logout', {})).catch(() => {});
    this.user.set(null);
    this.sites.set([]);
  }

  async loadSites(): Promise<void> {
    const res = await firstValueFrom(this.http.get<{ sites: Site[] }>('api/sites'));
    this.sites.set(res.sites);
  }

  async addSite(name: string, url: string, intervalMin: number): Promise<void> {
    const site = await firstValueFrom(this.http.post<Site>('api/sites', { name, url, intervalMin }));
    this.sites.update(list => [...list, site]);
  }

  async updateSite(id: number, patch: Partial<Pick<Site, 'name' | 'intervalMin' | 'enabled'>>): Promise<void> {
    this.replace(await firstValueFrom(this.http.post<Site>(`api/sites/${id}`, patch)));
  }

  async removeSite(id: number): Promise<void> {
    await firstValueFrom(this.http.post(`api/sites/${id}/delete`, {}));
    this.sites.update(list => list.filter(s => s.id !== id));
  }

  async pingNow(id: number): Promise<void> {
    this.pinging.update(set => new Set(set).add(id));
    try {
      this.replace(await firstValueFrom(this.http.post<Site>(`api/sites/${id}/ping`, {})));
    } finally {
      this.pinging.update(set => {
        const next = new Set(set);
        next.delete(id);
        return next;
      });
    }
  }

  private replace(site: Site): void {
    this.sites.update(list => list.map(s => (s.id === site.id ? site : s)));
  }
}

export function last(site: Site) {
  return site.history.at(-1);
}

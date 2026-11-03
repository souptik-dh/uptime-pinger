import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';

const RELOAD_KEY = 'uptime-pinger.challenge-reload';

/**
 * Free hosts such as InfinityFree answer with a JavaScript bot-check page instead of JSON once their test cookie
 * expires (every 6 hours). Reloading lets the browser pass the check again. Reloads at most once a minute so a
 * check that keeps failing shows an error instead of looping.
 */
export const challengeInterceptor: HttpInterceptorFn = (req, next) =>
  next(req).pipe(
    catchError((e: unknown) => {
      const text = e instanceof HttpErrorResponse ? String(e.error?.text ?? e.error ?? '') : '';
      if (text.includes('slowAES') || text.includes('/aes.js')) {
        let last = 0;
        try {
          last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
          sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
        } catch {}
        if (Date.now() - last > 60_000) location.reload();
      }
      return throwError(() => e);
    }),
  );

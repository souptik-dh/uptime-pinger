import { Component, effect, inject, untracked } from '@angular/core';
import { ApiService } from './api.service';
import { Dashboard } from './dashboard';
import { Landing } from './landing';

@Component({
  selector: 'app-root',
  imports: [Dashboard, Landing],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly api = inject(ApiService);

  constructor() {
    this.api.checkSession();
    // Land at the top after signing in or out instead of wherever the landing page was scrolled.
    effect(() => {
      this.api.user();
      untracked(() => window.scrollTo({ top: 0 }));
    });
  }
}

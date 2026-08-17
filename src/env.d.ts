/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface CartItem {
  /** Client-generated id for editing/removing a specific line before checkout. */
  lineId: string;
  photoId: string;
  type: 'print' | 'digital';
  qty: number;
  // Print-only fields — absent for type: 'digital'.
  widthCm?: number;
  heightCm?: number;
  paper?: string;
  crop?: 'fit' | 'crop' | 'border';
}

declare namespace App {
  interface SessionData {
    cart?: CartItem[];
    /** The single source of truth for "who is signed in" — the admin panel and the
     *  public account area share one session, and the admin guard is a check on
     *  `user.role`, not a separate boolean flag. */
    user?: import('./lib/users').SessionUser;
  }
}

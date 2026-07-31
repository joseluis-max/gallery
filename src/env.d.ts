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
    adminAuthed?: boolean;
  }
}

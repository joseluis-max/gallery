import type { Dictionary } from './es';

export const en: Dictionary = {
  nav: {
    gallery: 'Gallery',
    about: 'About',
    cart: 'Cart',
  },
  home: {
    heroTitle: 'José Valdiviezo',
    heroSubtitle: 'Galápagos Photography — Cuenca, Ecuador',
    featuredTitle: 'Featured selection',
    viewGallery: 'View full gallery',
  },
  gallery: {
    title: 'Gallery',
    allTags: 'All',
    empty: 'No photographs published yet.',
  },
  collections: {
    empty: 'No photographs found in this collection.',
  },
  detail: {
    back: 'Back to gallery',
    specs: {
      camera: 'Camera',
      lens: 'Lens',
      iso: 'ISO',
      aperture: 'Aperture',
      shutter: 'Shutter',
      location: 'Location',
    },
    buyPrint: 'Buy print',
    buyDigital: 'Buy digital file',
  },
  about: {
    title: 'About José',
    body: 'José Valdiviezo is a photographer based in Cuenca, Ecuador. Shooting on a Sony A7III, he documents the wildlife and landscapes of the Galápagos Islands with a close eye for natural light and negative space.',
  },
  cart: {
    title: 'Cart',
    empty: 'Your cart is empty.',
  },
  footer: {
    rights: 'All rights reserved.',
  },
  notFound: {
    photoTitle: 'Photograph not found',
    photoBody: 'This photograph is no longer available, or the link is incorrect.',
  },
  pricing: {
    size: 'Size',
    custom: 'Custom',
    widthCm: 'Width (cm)',
    heightCm: 'Height (cm)',
    paper: 'Paper',
    qty: 'Qty',
    addToCart: 'Add to cart',
    aspectMismatchNotice: "This size doesn't match the photo's proportions.",
    cropOption: 'Crop to fit',
    borderOption: 'Add white border',
    errors: {
      SIZE_TOO_SMALL: 'That size is too small.',
      SIZE_TOO_LARGE: 'That size is too large.',
      EXCEEDS_MAX_PRINT_CM: "This size exceeds the photo's resolution.",
      UNKNOWN_PAPER_STOCK: 'Choose a valid paper stock.',
    },
  },
};

export interface Dictionary {
  nav: { gallery: string; about: string; cart: string };
  home: { heroTitle: string; heroSubtitle: string; featuredTitle: string; viewGallery: string };
  gallery: { title: string; allTags: string; empty: string };
  collections: { empty: string };
  detail: {
    back: string;
    specs: { camera: string; lens: string; iso: string; aperture: string; shutter: string; location: string };
    buyPrint: string;
    buyDigital: string;
  };
  about: { title: string; body: string };
  cart: { title: string; empty: string };
  footer: { rights: string };
  notFound: { photoTitle: string; photoBody: string };
  pricing: {
    size: string;
    custom: string;
    widthCm: string;
    heightCm: string;
    paper: string;
    qty: string;
    addToCart: string;
    aspectMismatchNotice: string;
    cropOption: string;
    borderOption: string;
    errors: Record<'SIZE_TOO_SMALL' | 'SIZE_TOO_LARGE' | 'EXCEEDS_MAX_PRINT_CM' | 'UNKNOWN_PAPER_STOCK', string>;
  };
}

export const es: Dictionary = {
  nav: {
    gallery: 'Galería',
    about: 'Acerca de',
    cart: 'Carrito',
  },
  home: {
    heroTitle: 'José Valdiviezo',
    heroSubtitle: 'Fotografía de Galápagos — Cuenca, Ecuador',
    featuredTitle: 'Selección destacada',
    viewGallery: 'Ver galería completa',
  },
  gallery: {
    title: 'Galería',
    allTags: 'Todas',
    empty: 'Aún no hay fotografías publicadas.',
  },
  collections: {
    empty: 'No se encontraron fotografías en esta colección.',
  },
  detail: {
    back: 'Volver a la galería',
    specs: {
      camera: 'Cámara',
      lens: 'Lente',
      iso: 'ISO',
      aperture: 'Apertura',
      shutter: 'Obturación',
      location: 'Ubicación',
    },
    buyPrint: 'Comprar impresión',
    buyDigital: 'Comprar archivo digital',
  },
  about: {
    title: 'Acerca de José',
    body: 'José Valdiviezo es un fotógrafo radicado en Cuenca, Ecuador. Trabaja con una Sony A7III, documentando la vida silvestre y los paisajes de las Islas Galápagos con especial atención a la luz natural y al espacio negativo.',
  },
  cart: {
    title: 'Carrito',
    empty: 'Tu carrito está vacío.',
  },
  footer: {
    rights: 'Todos los derechos reservados.',
  },
  notFound: {
    photoTitle: 'Fotografía no encontrada',
    photoBody: 'Esta fotografía ya no está disponible o el enlace es incorrecto.',
  },
  pricing: {
    size: 'Tamaño',
    custom: 'Personalizado',
    widthCm: 'Ancho (cm)',
    heightCm: 'Alto (cm)',
    paper: 'Papel',
    qty: 'Cantidad',
    addToCart: 'Agregar al carrito',
    aspectMismatchNotice: 'Este tamaño no coincide con las proporciones de la foto.',
    cropOption: 'Recortar para ajustar',
    borderOption: 'Agregar borde blanco',
    errors: {
      SIZE_TOO_SMALL: 'El tamaño es demasiado pequeño.',
      SIZE_TOO_LARGE: 'El tamaño es demasiado grande.',
      EXCEEDS_MAX_PRINT_CM: 'Este tamaño excede la resolución de la foto.',
      UNKNOWN_PAPER_STOCK: 'Selecciona un tipo de papel válido.',
    },
  },
};

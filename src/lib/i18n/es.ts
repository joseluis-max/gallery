export interface Dictionary {
  nav: {
    competitions: string;
    portfolio: string;
    allPhotographs: string;
    about: string;
    cart: string;
    account: string;
    signIn: string;
    menu: string;
    close: string;
    viewAll: string;
  };
  home: { heroTitle: string; heroSubtitle: string; featuredTitle: string; viewGallery: string };
  gallery: { title: string; allTags: string; empty: string };
  competitions: {
    title: string;
    intro: string;
    empty: string;
    /** Contains a `{count}` placeholder. */
    photoCount: string;
    backToAll: string;
  };
  portfolio: { title: string; intro: string; empty: string };
  detail: {
    back: string;
    specs: { camera: string; lens: string; iso: string; aperture: string; shutter: string; location: string };
    buyDigital: string;
    /** Contains a `{remaining}` placeholder. */
    downloadFree: string;
    freeUsedUp: string;
    freeSignedOut: string;
    alreadyYours: string;
    downloadAgain: string;
  };
  about: { title: string; body: string };
  cart: {
    title: string;
    empty: string;
    total: string;
    checkout: string;
    digitalFile: string;
    remove: string;
    /** Contains a `{count}` placeholder. */
    unavailable: string;
    /** Contains a `{price}` placeholder — the discounted per-photo price. */
    volumeDiscount: string;
    /** Contains `{count}` and `{price}` placeholders. */
    nextTier: string;
  };
  account: {
    signInTitle: string;
    registerTitle: string;
    accountTitle: string;
    name: string;
    email: string;
    password: string;
    currentPassword: string;
    newPassword: string;
    signIn: string;
    signOut: string;
    register: string;
    noAccount: string;
    haveAccount: string;
    createOne: string;
    profile: string;
    saveProfile: string;
    changePassword: string;
    savedProfile: string;
    savedPassword: string;
    orders: string;
    noOrders: string;
    orderNumber: string;
    date: string;
    status: string;
    total: string;
    viewOrder: string;
    passwordHint: string;
    errors: Record<
      | 'INVALID_CREDENTIALS'
      | 'TOO_MANY_ATTEMPTS'
      | 'EMAIL_TAKEN'
      | 'INVALID_EMAIL'
      | 'PASSWORD_TOO_SHORT'
      | 'NAME_REQUIRED'
      | 'UNKNOWN',
      string
    >;
    statuses: Record<'pending' | 'paid' | 'cancelled' | 'refunded', string>;
  };
  footer: { rights: string };
  notFound: { photoTitle: string; photoBody: string };
}

export const es: Dictionary = {
  nav: {
    competitions: 'Competencias',
    portfolio: 'Portafolio',
    allPhotographs: 'Todas las fotografías',
    about: 'Acerca de',
    cart: 'Carrito',
    account: 'Mi cuenta',
    signIn: 'Iniciar sesión',
    menu: 'Menú',
    close: 'Cerrar',
    viewAll: 'Ver todas las competencias',
  },
  home: {
    heroTitle: 'José Valdiviezo',
    heroSubtitle: 'Fotografía de naturaleza y vida silvestre — Cuenca, Ecuador',
    featuredTitle: 'Selección destacada',
    viewGallery: 'Ver galería completa',
  },
  gallery: {
    title: 'Galería',
    allTags: 'Todas',
    empty: 'Aún no hay fotografías publicadas.',
  },
  competitions: {
    title: 'Competencias',
    intro: 'Eventos deportivos cubiertos por José. Cada galería reúne las fotografías de esa jornada.',
    empty: 'Todavía no hay competencias publicadas.',
    photoCount: '{count} fotografías',
    backToAll: 'Volver a competencias',
  },
  portfolio: {
    title: 'Portafolio',
    intro: 'Trabajo personal fuera de las competencias: paisaje y vida silvestre.',
    empty: 'Todavía no hay fotografías publicadas.',
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
    buyDigital: 'Comprar archivo digital',
    downloadFree: 'Descargar gratis ({remaining} restantes)',
    freeUsedUp: 'Ya usaste tus 2 descargas gratuitas.',
    freeSignedOut: 'Crea una cuenta y llévate 2 fotografías gratis',
    alreadyYours: 'Ya es tuya',
    downloadAgain: 'Descargar de nuevo',
  },
  about: {
    title: 'Acerca de José',
    body: 'José Valdiviezo es un fotógrafo radicado en Cuenca, Ecuador. Trabaja con una Sony A7III y su trabajo se centra en la fotografía de vida silvestre: aves, mamíferos y los paisajes que habitan, siempre con especial atención a la luz natural y al espacio negativo.',
  },
  cart: {
    title: 'Carrito',
    empty: 'Tu carrito está vacío.',
    total: 'Total',
    checkout: 'Pagar',
    digitalFile: 'Archivo digital',
    remove: 'Quitar',
    unavailable: '{count} artículo(s) ya no están disponibles y se omitieron.',
    volumeDiscount: 'Descuento por volumen — {price} por foto',
    nextTier: 'Agrega {count} foto(s) más y todas cuestan {price} cada una.',
  },
  account: {
    signInTitle: 'Iniciar sesión',
    registerTitle: 'Crear cuenta',
    accountTitle: 'Mi cuenta',
    name: 'Nombre',
    email: 'Correo electrónico',
    password: 'Contraseña',
    currentPassword: 'Contraseña actual',
    newPassword: 'Nueva contraseña',
    signIn: 'Iniciar sesión',
    signOut: 'Cerrar sesión',
    register: 'Crear cuenta',
    noAccount: '¿Aún no tienes cuenta?',
    haveAccount: '¿Ya tienes cuenta?',
    createOne: 'Crear una',
    profile: 'Datos personales',
    saveProfile: 'Guardar cambios',
    changePassword: 'Cambiar contraseña',
    savedProfile: 'Datos actualizados.',
    savedPassword: 'Contraseña actualizada.',
    orders: 'Mis pedidos',
    noOrders: 'Todavía no tienes pedidos.',
    orderNumber: 'Pedido',
    date: 'Fecha',
    status: 'Estado',
    total: 'Total',
    viewOrder: 'Ver',
    passwordHint: 'Mínimo 8 caracteres.',
    errors: {
      INVALID_CREDENTIALS: 'Correo o contraseña incorrectos.',
      TOO_MANY_ATTEMPTS: 'Demasiados intentos. Vuelve a intentarlo en unos minutos.',
      EMAIL_TAKEN: 'Ya existe una cuenta con este correo.',
      INVALID_EMAIL: 'Ingresa un correo electrónico válido.',
      PASSWORD_TOO_SHORT: 'La contraseña debe tener al menos 8 caracteres.',
      NAME_REQUIRED: 'Ingresa tu nombre.',
      UNKNOWN: 'Algo salió mal. Inténtalo de nuevo.',
    },
    statuses: {
      pending: 'Pendiente de pago',
      paid: 'Pagado',
      cancelled: 'Cancelado',
      refunded: 'Reembolsado',
    },
  },
  footer: {
    rights: 'Todos los derechos reservados.',
  },
  notFound: {
    photoTitle: 'Fotografía no encontrada',
    photoBody: 'Esta fotografía ya no está disponible o el enlace es incorrecto.',
  },
};

export interface Dictionary {
  nav: { gallery: string; about: string; cart: string; account: string; signIn: string };
  home: { heroTitle: string; heroSubtitle: string; featuredTitle: string; viewGallery: string };
  gallery: { title: string; allTags: string; empty: string };
  collections: { empty: string };
  detail: {
    back: string;
    specs: { camera: string; lens: string; iso: string; aperture: string; shutter: string; location: string };
    buyDigital: string;
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
    gallery: 'Galería',
    about: 'Acerca de',
    cart: 'Carrito',
    account: 'Mi cuenta',
    signIn: 'Iniciar sesión',
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
    buyDigital: 'Comprar archivo digital',
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

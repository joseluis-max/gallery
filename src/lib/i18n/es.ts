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
  home: {
    heroTitle: string;
    heroSubtitle: string;
    heroBody: string;
    featuredTitle: string;
    viewGallery: string;
    recentCompetitions: string;
    /** Three plain facts under the hero. Not marketing — the questions a first-time
     *  visitor actually has before scrolling into the photographs. */
    trustInstant: string;
    trustMethods: string;
    trustOriginal: string;
  };
  gallery: {
    title: string;
    allTags: string;
    empty: string;
    addToCart: string;
    removeFromCart: string;
    searchPlaceholder: string;
    searchNoResults: string;
  };
  competitions: {
    title: string;
    intro: string;
    empty: string;
    /** Contains a `{count}` placeholder. */
    photoCount: string;
    backToAll: string;
    allYears: string;
    /** Contains `{competitions}` and `{photos}` placeholders. */
    summary: string;
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
  about: {
    title: string;
    body: string;
    eyebrow: string;
    contactTitle: string;
    contactLocation: string;
    /** Why someone would write: this site's only inbound channel is event organisers. */
    contactInvite: string;
    portfolioNote: string;
  };
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
    /** Contains `{count}` and `{qty}` placeholders — the label under the tier meter. */
    tierProgress: string;
    keepShopping: string;
    trustInstant: string;
    /** Contains `{days}` and `{uses}` placeholders. */
    trustLinks: string;
  };
  checkout: {
    title: string;
    orderSummary: string;
    total: string;
    /** Labels the payment column. A noun, deliberately distinct from `title`,
     *  which heads the whole page — in Spanish both would otherwise read 'Pagar'. */
    paymentSection: string;
    loading: string;
    /** Contains a `{time}` placeholder — mm:ss until the payment form expires. */
    expiresIn: string;
    expired: string;
    startAgain: string;
    emailLabel: string;
    emailHint: string;
    emailContinue: string;
    /** The three beats of buying, shown above the page so "how much longer" is answerable
     *  without guessing. */
    steps: { cart: string; payment: string; downloads: string };
    contactSection: string;
    /** Names the gateway on the panel that collects the card — the reassurance a buyer
     *  looks for before typing one. */
    securedBy: string;
    summaryEdit: string;
    /** Contains `{days}` and `{uses}` placeholders. */
    trustLinks: string;
    trustResend: string;
    errors: Record<'WIDGET_UNAVAILABLE' | 'INVALID_EMAIL' | 'UNKNOWN', string>;
  };
  /** Direct bank transfer: the method chooser on the checkout page, the transfer page
   *  itself, and the states the order page shows while a receipt is being reviewed. */
  transfer: {
    methodTitle: string;
    methodCard: string;
    methodCardHint: string;
    methodTransfer: string;
    methodTransferHint: string;
    title: string;
    /** Contains an `{amount}` placeholder — the exact figure to transfer. */
    intro: string;
    accountTitle: string;
    bank: string;
    accountType: string;
    accountNumber: string;
    holder: string;
    idNumber: string;
    amount: string;
    /** Contains an `{order}` placeholder — the short order number to type into the bank's
     *  description field, which is what lets the photographer match the money to a pedido. */
    conceptHint: string;
    copy: string;
    copied: string;
    uploadTitle: string;
    uploadHint: string;
    fileLabel: string;
    referenceLabel: string;
    referenceHint: string;
    emailLabel: string;
    emailHint: string;
    submit: string;
    submitting: string;
    payByCard: string;
    reviewNotice: string;
    inReviewTitle: string;
    inReview: string;
    rejectedTitle: string;
    /** Contains a `{reason}` placeholder — what the photographer wrote when refusing it. */
    rejected: string;
    tryAgain: string;
    payByTransfer: string;
    errors: Record<
      | 'RECEIPT_REQUIRED'
      | 'RECEIPT_TOO_LARGE'
      | 'RECEIPT_TYPE_NOT_ALLOWED'
      | 'TOO_MANY_RECEIPTS'
      | 'INVALID_EMAIL'
      | 'EMAIL_REQUIRED'
      | 'ORDER_NOT_FOUND'
      | 'ORDER_NOT_PENDING'
      | 'UNKNOWN',
      string
    >;
  };
  order: {
    /** Shown when the gateway reported the payment as cancelled or declined. */
    declined: string;
    /** Shown when the payment could not be confirmed — a network failure, or a
     *  confirmation that did not add up. Deliberately the same message for both. */
    unconfirmed: string;
    completePayment: string;
    /** Heading over the per-item download links shown on a paid order. */
    downloadsTitle: string;
    download: string;
    /** Contains `{days}` and `{uses}` placeholders. */
    downloadsValidity: string;
    /** Contains `{count}` and `{email}` placeholders. */
    emailedTo: string;
    /** Shown instead of `emailedTo` when the order carries no address to send to. */
    noEmail: string;
    /** The three-beat trail down the order page. A transfer sits in `pending` for hours,
     *  so "what has happened so far" is the question this page has to answer. */
    tracking: {
      title: string;
      created: string;
      receiptUploaded: string;
      awaitingPayment: string;
      noReceiptYet: string;
      released: string;
      pendingRelease: string;
      rejected: string;
    };
    /** Labels the payment method on a paid order. */
    methodLabel: string;
    methodCard: string;
    methodTransfer: string;
  };
  /** Copy for the order-confirmation email. It lives in the dictionary rather than beside
   *  the sender so there is one translation home for the whole product; lib/orderEmail.ts
   *  renders it. */
  email: {
    /** Contains an `{order}` placeholder. */
    subject: string;
    intro: string;
    downloadsTitle: string;
    download: string;
    /** Contains `{days}` and `{uses}` placeholders. */
    validity: string;
    total: string;
    viewOrder: string;
    footer: string;
    /** Sent the moment a comprobante is uploaded. A bank transfer is not confirmed by a
     *  gateway in ten seconds — it waits for a human — so this is what a guest who closes
     *  the tab has to get back to their order with. */
    transferReceived: {
      /** Contains an `{order}` placeholder. */
      subject: string;
      intro: string;
      body: string;
    };
    /** Sent when the photographer refuses a comprobante. Without it, a buyer whose receipt
     *  was unreadable would wait forever for downloads that are never coming. */
    transferRejected: {
      /** Contains an `{order}` placeholder. */
      subject: string;
      intro: string;
      reasonLabel: string;
      retry: string;
    };
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
    /** The standing free-download balance, promoted out of the photo page so it is
     *  something an account holder can see and spend. Contains a `{count}` placeholder. */
    freeBalance: string;
    freeBalanceHint: string;
    freeBalanceSpent: string;
    chooseFree: string;
    orderNumber: string;
    date: string;
    status: string;
    total: string;
    viewOrder: string;
    passwordHint: string;
    /** The half of the sign-in screen that carries a photograph rather than a form. */
    heroTitle: string;
    heroBody: string;
    freeOffer: string;
    freeOfferHint: string;
    guestNote: string;
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
  notFound: { photoTitle: string; photoBody: string; recentTitle: string };
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
    heroSubtitle: 'Fotografía deportiva — Cuenca, Ecuador',
    heroBody: 'Cada competencia se publica como su propia galería, para que quienes corrieron puedan encontrarse.',
    featuredTitle: 'Selección destacada',
    viewGallery: 'Ver todas las fotografías',
    recentCompetitions: 'Competencias recientes',
    trustInstant: 'Descarga inmediata',
    trustMethods: 'Tarjeta o transferencia',
    trustOriginal: 'Archivo original, sin marca de agua',
  },
  gallery: {
    title: 'Galería',
    allTags: 'Todas',
    empty: 'Aún no hay fotografías publicadas.',
    addToCart: 'Añadir al carrito',
    removeFromCart: 'Quitar del carrito',
    searchPlaceholder: 'Buscar por nombre de archivo',
    searchNoResults: 'Ninguna fotografía coincide con esa búsqueda.',
  },
  competitions: {
    title: 'Competencias',
    intro: 'Eventos deportivos cubiertos por José. Cada galería reúne las fotografías de esa jornada.',
    empty: 'Todavía no hay competencias publicadas.',
    photoCount: '{count} fotografías',
    backToAll: 'Volver a competencias',
    allYears: 'Todos los años',
    summary: '{competitions} competencias · {photos} fotografías',
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
    eyebrow: 'Acerca de',
    contactTitle: 'Contacto',
    contactLocation: 'Cuenca, Ecuador',
    contactInvite: '¿Organizas una competencia? Escríbeme para cubrirla.',
    portfolioNote: 'Del portafolio personal — paisaje y vida silvestre.',
    // BORRADOR — pendiente de revisión de José. Escrito a propósito sin premios, clientes
    // ni años de experiencia: nada aquí afirma algo que no se pueda verificar.
    body: 'José Valdiviezo es un fotógrafo radicado en Cuenca, Ecuador. Su trabajo se centra en la fotografía deportiva: el instante decidido, el gesto del esfuerzo y la tensión de la competencia. Cada competencia se publica como una galería propia, para que quienes participaron puedan encontrar sus fotografías. Junto a ese trabajo mantiene un portafolio de paisaje y vida silvestre, donde la misma atención a la luz natural se toma su tiempo.',
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
    tierProgress: '{count} de {qty} fotografías',
    keepShopping: 'Seguir viendo fotografías',
    trustInstant: 'Descarga inmediata tras el pago',
    trustLinks: 'Enlaces válidos {days} día(s) y hasta {uses} descargas',
  },
  checkout: {
    title: 'Pagar',
    orderSummary: 'Resumen del pedido',
    total: 'Total',
    paymentSection: 'Pago',
    loading: 'Cargando el formulario de pago…',
    expiresIn: 'El formulario de pago vence en {time}.',
    expired: 'El formulario de pago venció. Vuelve a empezar para generar uno nuevo.',
    startAgain: 'Volver a empezar',
    emailLabel: 'Correo electrónico',
    emailHint: 'Te enviaremos aquí los enlaces de descarga. Revísalo bien: es la única forma de recibir tus fotografías.',
    emailContinue: 'Continuar',
    steps: { cart: 'Carrito', payment: 'Pago', downloads: 'Descargas' },
    contactSection: 'Datos de contacto',
    securedBy: 'Pago procesado por Payphone',
    summaryEdit: 'Editar',
    trustLinks: 'Enlaces válidos {days} día(s), hasta {uses} descargas',
    trustResend: 'Te los reenviamos cuando los pierdas',
    errors: {
      WIDGET_UNAVAILABLE: 'No pudimos cargar el formulario de pago. Revisa tu conexión y vuelve a intentarlo.',
      INVALID_EMAIL: 'Ingresa un correo electrónico válido.',
      UNKNOWN: 'Algo salió mal. Inténtalo de nuevo.',
    },
  },
  transfer: {
    methodTitle: 'Cómo quieres pagar',
    methodCard: 'Tarjeta de crédito o débito',
    methodCardHint: 'Pago inmediato. Recibes tus descargas al instante.',
    methodTransfer: 'Transferencia bancaria',
    methodTransferHint: 'Transfieres desde tu banco y subes el comprobante. Activamos tus descargas al verificarlo.',
    title: 'Pago por transferencia bancaria',
    intro: 'Transfiere exactamente {amount} a la siguiente cuenta y luego sube el comprobante. Revisamos cada transferencia a mano, así que tus descargas se activan una vez que confirmemos el depósito.',
    accountTitle: 'Datos de la cuenta',
    bank: 'Banco',
    accountType: 'Tipo de cuenta',
    accountNumber: 'Número de cuenta',
    holder: 'Titular',
    idNumber: 'Cédula',
    amount: 'Monto exacto',
    conceptHint: 'Si tu banco te deja escribir un concepto o descripción, pon el número de pedido {order}. Nos ayuda a encontrar tu transferencia más rápido.',
    copy: 'Copiar',
    copied: 'Copiado',
    uploadTitle: 'Sube tu comprobante',
    uploadHint: 'Captura de pantalla o PDF del comprobante, hasta 10 MB. Formatos: JPG, PNG, WEBP, HEIC o PDF.',
    fileLabel: 'Comprobante',
    referenceLabel: 'Número de documento o referencia (opcional)',
    referenceHint: 'El número que te dio tu banco al hacer la transferencia.',
    emailLabel: 'Correo electrónico',
    emailHint: 'Aquí te avisamos cuando verifiquemos el pago y te enviamos los enlaces de descarga.',
    submit: 'Enviar comprobante',
    submitting: 'Enviando…',
    payByCard: 'Prefiero pagar con tarjeta',
    reviewNotice: 'Las transferencias se revisan a mano, normalmente dentro de las siguientes 24 horas.',
    inReviewTitle: 'Comprobante en revisión',
    inReview: 'Recibimos tu comprobante y lo estamos verificando. Te escribiremos en cuanto confirmemos el pago y aquí mismo aparecerán tus descargas.',
    rejectedTitle: 'No pudimos verificar tu transferencia',
    rejected: 'Motivo: {reason}',
    tryAgain: 'Subir otro comprobante',
    payByTransfer: 'Pagar por transferencia bancaria',
    errors: {
      RECEIPT_REQUIRED: 'Adjunta el comprobante de tu transferencia.',
      RECEIPT_TOO_LARGE: 'El archivo pesa más de 10 MB. Sube una captura o un PDF más liviano.',
      RECEIPT_TYPE_NOT_ALLOWED: 'Formato no admitido. Sube una imagen (JPG, PNG, WEBP, HEIC) o un PDF.',
      TOO_MANY_RECEIPTS: 'Ya subiste varios comprobantes para este pedido. Escríbenos y lo revisamos contigo.',
      INVALID_EMAIL: 'Ingresa un correo electrónico válido.',
      EMAIL_REQUIRED: 'Necesitamos tu correo para enviarte los enlaces de descarga.',
      ORDER_NOT_FOUND: 'No encontramos este pedido.',
      ORDER_NOT_PENDING: 'Este pedido ya no está pendiente de pago.',
      UNKNOWN: 'Algo salió mal. Inténtalo de nuevo.',
    },
  },
  order: {
    declined: 'El pago fue cancelado o rechazado. No se te cobró nada; puedes intentarlo de nuevo.',
    unconfirmed: 'No pudimos confirmar el pago. Si se te realizó un cargo, se reversará automáticamente. Escríbenos si tienes dudas.',
    completePayment: 'Completar el pago',
    downloadsTitle: 'Tus descargas',
    download: 'Descargar',
    downloadsValidity: 'Cada enlace es válido por {days} día(s) y hasta {uses} descargas. Vuelve a esta página cuando quieras y se generará uno nuevo.',
    emailedTo: 'También enviamos {count} enlace(s) de descarga a {email}.',
    noEmail: 'Este pedido no tiene un correo asociado, así que descarga tus archivos desde aquí.',
    tracking: {
      title: 'Seguimiento',
      created: 'Pedido creado',
      receiptUploaded: 'Comprobante subido',
      awaitingPayment: 'Esperando el pago',
      noReceiptYet: 'Todavía sin comprobante',
      released: 'Descargas activadas',
      pendingRelease: 'Al confirmar el pago',
      rejected: 'No pudimos verificar el comprobante',
    },
    methodLabel: 'Método de pago',
    methodCard: 'Tarjeta',
    methodTransfer: 'Transferencia bancaria',
  },
  email: {
    subject: 'Tu pedido #{order} — José Valdiviezo',
    intro: 'Gracias por tu compra. Tus archivos digitales están listos para descargar.',
    downloadsTitle: 'Tus descargas',
    download: 'Descargar',
    validity: 'Cada enlace es válido por {days} día(s) y hasta {uses} descargas.',
    total: 'Total',
    viewOrder: 'Ver tu pedido',
    footer: 'José Valdiviezo — Fotografía',
    transferReceived: {
      subject: 'Recibimos tu comprobante — pedido #{order}',
      intro: 'Gracias. Recibimos el comprobante de tu transferencia y lo estamos verificando.',
      body: 'Normalmente confirmamos dentro de las siguientes 24 horas. Cuando lo hagamos te enviaremos otro correo con tus enlaces de descarga, y también aparecerán en la página de tu pedido.',
    },
    transferRejected: {
      subject: 'No pudimos verificar tu transferencia — pedido #{order}',
      intro: 'Revisamos el comprobante que subiste y no pudimos confirmar el pago de este pedido.',
      reasonLabel: 'Motivo',
      retry: 'Puedes subir otro comprobante desde la página de tu pedido. Si crees que es un error, responde a este correo.',
    },
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
    freeBalance: 'Te quedan {count} descarga(s) gratuita(s)',
    freeBalanceHint: 'Se usan en cualquier fotografía, sin caducidad.',
    freeBalanceSpent: 'Ya usaste tus descargas gratuitas.',
    chooseFree: 'Elegir una foto',
    orderNumber: 'Pedido',
    date: 'Fecha',
    status: 'Estado',
    total: 'Total',
    viewOrder: 'Ver',
    passwordHint: 'Mínimo 8 caracteres.',
    heroTitle: 'Tus fotografías, cuando las necesites',
    heroBody: 'Con una cuenta guardas tus pedidos y puedes volver a descargar lo que compraste, aunque venza el enlace del correo.',
    freeOffer: 'Llévate 2 fotografías gratis',
    freeOfferHint: 'Se aplican al crear la cuenta, en la fotografía que elijas.',
    guestNote: 'Comprar no requiere cuenta — también puedes pagar como invitado.',
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
    recentTitle: 'Publicadas recientemente',
  },
};

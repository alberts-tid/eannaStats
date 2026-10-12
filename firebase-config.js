// Configuración web de Firebase (es pública por diseño; la seguridad la dan las reglas de Firestore y App Check).
export const firebaseConfig = {
  apiKey: 'AIzaSyApisr_Iaqzk6v_cf88zkyNHLHNlvaWZ_w',
  authDomain: 'eannastats.firebaseapp.com',
  projectId: 'eannastats',
  storageBucket: 'eannastats.firebasestorage.app',
  messagingSenderId: '584908523071',
  appId: '1:584908523071:web:1d6c5be5acc7a68ec05a8a',
};

// Clave de sitio de reCAPTCHA Enterprise registrada en Firebase Console → App Check.
// Vacía = App Check desactivado (la IA fallará si App Check está forzado en AI Logic).
export const appCheckSiteKey = '';

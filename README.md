# eannaStats

Web estática (GitHub Pages) para sacar estadísticas de baloncesto a partir de la foto del acta.
Subes la imagen, un modelo de visión transcribe el marcador corrido y la web calcula
el box score por jugador: puntos, 2PM, 3PM, tiros libres, faltas y puntos por cuarto.
Cada partido se guarda en Firestore y la web muestra las estadísticas por partido y las acumuladas.

## Cómo funciona

- La IA es Gemini, a través de Firebase AI Logic. Hace falta iniciar sesión.
- La IA solo transcribe el acta (marcador acumulado con su dorsal, triples, faltas, finales de cuarto) en JSON con esquema.
- El cálculo lo hace `boxscore.js` sin IA: cada anotación vale la diferencia con el marcador anterior (+1 tiro libre, +2 canasta, +3 triple).
- Si algo no cuadra (saltos de +4, cuartos que no suman, dorsales que no están en la lista) aparece en «Revisa», y el marcador leído se puede corregir a mano.
- Vistas: **Acta** (subir, revisar, guardar, descargar JPG/CSV), **Partidos** (lista por equipo) y **Acumulado** (totales y medias por jugador y puntos por partido).

## Ejecutar en local

```bash
python3 -m http.server 8000
```

Abre `http://localhost:8000/`; con `http://localhost:8000/?demo=1` se carga un partido de ejemplo sin llamar a la IA.
Hay que servirla por HTTP: abrir `index.html` con doble clic no funciona.

Tests: `npm test`.

## Configurar Firebase

Proyecto Firebase: `eannastats` (configuración web en `firebase-config.js`).

1. **AI Logic** → Get started → Gemini Developer API.
2. **App Check**: registra la app web con reCAPTCHA Enterprise y pon la clave de sitio en `appCheckSiteKey` (`firebase-config.js`). Si AI Logic tiene App Check forzado y la web no lo tiene configurado, la IA devuelve 401. En `localhost`, el SDK imprime un token de depuración en la consola del navegador: regístralo en App Check → Administrar tokens de depuración.
3. **Authentication** → Email/Password y crea los usuarios.
4. **Firestore**: crea la base de datos y publica `firestore.rules` (pegándolo en la pestaña Reglas o con `npx firebase-tools deploy --only firestore:rules`).

## Publicar con Firebase Hosting (repo privado)

```bash
npx firebase-tools login
npx firebase-tools deploy --only hosting
```

Queda en `https://eannastats.web.app`. Ese dominio ya está autorizado en Authentication.

## GitHub Pages

Settings → Pages → Deploy from a branch → `main` / raíz. Añade `<usuario>.github.io` a los dominios autorizados de Firebase Authentication.

## Probar con emuladores (sin tocar datos reales)

```bash
npx firebase-tools emulators:start --only auth,firestore --project eannastats
curl -s -X POST "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake" \
  -H 'Content-Type: application/json' -d '{"email":"coach@test.com","password":"test1234","returnSecureToken":true}'
```

Y abre `http://localhost:8000/?emulator`.

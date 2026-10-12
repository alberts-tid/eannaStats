# AGENTS.md

## Cursor Cloud specific instructions

- No grabar vídeo de las pruebas manuales; basta con capturas y la salida de los tests.
- Web estática: servir la raíz con `python3 -m http.server 8000` y abrir `http://localhost:8000/` (`?demo=1` carga el ejemplo sin IA).
- Tests del cálculo: `npm test` (Node 20+, sin dependencias).
- Pruebas de guardado sin tocar datos reales: `npx firebase-tools emulators:start --only auth,firestore --project eannastats` (requiere Java) y abrir la web con `?emulator`.

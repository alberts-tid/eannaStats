import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDocs, addDoc, updateDoc, deleteDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { computeBoxScore, parseGameDate, teamKey } from './boxscore.js';

export const COLLECTION = 'acta_partits';

let db = null;

export function initStore(app, { emulatorHost } = {}) {
  db = getFirestore(app);
  if (emulatorHost) connectFirestoreEmulator(db, emulatorHost, 8080);
  return db;
}

function summary(extraction) {
  const box = computeBoxScore(extraction);
  return {
    gameDate: parseGameDate(box.game?.date),
    teamKeys: box.teams.map((t) => teamKey(t.name)).filter(Boolean),
    teamNames: box.teams.map((t) => t.name || ''),
    score: box.teams.map((t) => t.finalScore),
  };
}

// Firestore rechaza `undefined`; pasar por JSON elimina esos campos.
const clean = (value) => JSON.parse(JSON.stringify(value));

export async function listGames() {
  const snap = await getDocs(collection(db, COLLECTION));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function saveGame(extraction, user, id = null) {
  const data = { extraction: clean(extraction), ...summary(extraction), updatedAt: serverTimestamp() };
  if (id) {
    await updateDoc(doc(db, COLLECTION, id), data);
    return id;
  }
  const ref = await addDoc(collection(db, COLLECTION), {
    ...data,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    createdByEmail: user.email || null,
  });
  return ref.id;
}

export async function deleteGame(id) {
  await deleteDoc(doc(db, COLLECTION, id));
}

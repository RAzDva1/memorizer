import { AppSettings, Card, Deck, MediaAsset } from './types';
import { detectLocale } from './i18n';

const DB_NAME = 'memorizer-db';
const DB_VERSION = 1;

type StoreName = 'decks' | 'cards' | 'media' | 'settings';

let dbPromise: Promise<IDBDatabase> | undefined;

const openDatabase = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('decks')) {
        db.createObjectStore('decks', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('cards')) {
        const cards = db.createObjectStore('cards', { keyPath: 'id' });
        cards.createIndex('deckId', 'deckId', { unique: false });
      }

      if (!db.objectStoreNames.contains('media')) {
        db.createObjectStore('media', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
};

const tx = async (storeName: StoreName, mode: IDBTransactionMode = 'readonly') => {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, mode);
  return transaction.objectStore(storeName);
};

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const all = async <T>(storeName: StoreName): Promise<T[]> => {
  const store = await tx(storeName);
  return requestToPromise<T[]>(store.getAll());
};

const get = async <T>(storeName: StoreName, id: string): Promise<T | undefined> => {
  const store = await tx(storeName);
  return requestToPromise<T | undefined>(store.get(id));
};

const put = async <T>(storeName: StoreName, value: T): Promise<void> => {
  const store = await tx(storeName, 'readwrite');
  await requestToPromise(store.put(value));
};

const remove = async (storeName: StoreName, id: string): Promise<void> => {
  const store = await tx(storeName, 'readwrite');
  await requestToPromise(store.delete(id));
};

export const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export const db = {
  getDecks: () => all<Deck>('decks'),
  getDeck: (id: string) => get<Deck>('decks', id),
  saveDeck: (deck: Deck) => put('decks', deck),
  deleteDeck: async (id: string) => {
    const cards = await db.getCardsByDeck(id);
    await Promise.all(cards.map((card) => remove('cards', card.id)));
    await remove('decks', id);
  },

  getCards: () => all<Card>('cards'),
  getCard: (id: string) => get<Card>('cards', id),
  saveCard: (card: Card) => put('cards', card),
  deleteCard: (id: string) => remove('cards', id),
  getCardsByDeck: async (deckId: string) => {
    const store = await tx('cards');
    const index = store.index('deckId');
    return requestToPromise<Card[]>(index.getAll(deckId));
  },

  getMedia: () => all<MediaAsset>('media'),
  getMediaAsset: (id?: string) => (id ? get<MediaAsset>('media', id) : Promise.resolve(undefined)),
  saveMedia: (asset: MediaAsset) => put('media', asset),
  deleteMedia: (id: string) => remove('media', id),

  getSettings: async (): Promise<AppSettings> => {
    const existing = await get<AppSettings & { id: string }>('settings', 'app');
    return existing ? { locale: existing.locale } : { locale: detectLocale() };
  },
  saveSettings: (settings: AppSettings) => put('settings', { id: 'app', ...settings }),

  replaceAll: async (decks: Deck[], cards: Card[], media: MediaAsset[], settings: AppSettings) => {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['decks', 'cards', 'media', 'settings'], 'readwrite');
      transaction.objectStore('decks').clear();
      transaction.objectStore('cards').clear();
      transaction.objectStore('media').clear();
      transaction.objectStore('settings').clear();
      decks.forEach((deck) => transaction.objectStore('decks').put(deck));
      cards.forEach((card) => transaction.objectStore('cards').put(card));
      media.forEach((asset) => transaction.objectStore('media').put(asset));
      transaction.objectStore('settings').put({ id: 'app', ...settings });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  },

  clearAll: async () => db.replaceAll([], [], [], { locale: detectLocale() }),
};

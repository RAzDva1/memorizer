export type Locale = 'ru' | 'en';

export type MediaType = 'image' | 'audio';

export type DeckSettings = {
  showQuestionText: boolean;
  showQuestionImage: boolean;
};

export type SrsState = {
  dueAt: string;
  intervalDays: number;
  ease: number;
  reviewCount: number;
  lastReviewedAt?: string;
};

export type Deck = {
  id: string;
  title: string;
  description: string;
  coverImageId?: string;
  locale: Locale;
  tags: string[];
  settings: DeckSettings;
  lastOpenedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type Card = {
  id: string;
  deckId: string;
  questionText: string;
  questionImageId?: string;
  answerText: string;
  answerAudioId?: string;
  order?: number;
  srs: SrsState;
  createdAt: string;
  updatedAt: string;
};

export type MediaAsset = {
  id: string;
  type: MediaType;
  mimeType: string;
  blob: Blob;
  createdAt: string;
};

export type AppSettings = {
  locale: Locale;
};

export type SyncSettings = {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
};

export type DeckStats = {
  total: number;
  due: number;
  learned: number;
};

export type ImportMedia = {
  id: string;
  type: MediaType;
  mimeType?: string;
  dataUrl?: string;
  url?: string;
  createdAt?: string;
};

export type ImportCard = {
  id?: string;
  questionText?: string;
  questionImageId?: string;
  answerText?: string;
  answerAudioId?: string;
};

export type ImportDeck = {
  id?: string;
  title: string;
  description?: string;
  coverImageId?: string;
  locale?: Locale;
  tags?: string[];
  settings?: Partial<DeckSettings>;
};

export type ImportBundle = {
  version: 1;
  deck: ImportDeck;
  cards: ImportCard[];
  media?: ImportMedia[];
};

export type BackupBundle = {
  version: 1;
  exportedAt: string;
  decks: Deck[];
  cards: Card[];
  media: Array<Omit<ImportMedia, 'url'> & { dataUrl: string; createdAt: string; mimeType: string }>;
  settings: AppSettings;
};

export type SyncCard = Omit<Card, 'srs'>;

export type SyncBundle = {
  version: 1;
  exportedAt: string;
  decks: Deck[];
  cards: SyncCard[];
  media: Array<Omit<ImportMedia, 'url'> & { dataUrl: string; createdAt: string; mimeType: string }>;
};

export type ImportMode = 'copy' | 'replace' | 'merge';

export type ImportPreview = {
  bundle: ImportBundle | BackupBundle;
  kind: 'deck' | 'backup';
  title: string;
  cardCount: number;
  mediaCount: number;
  existingDeckId?: string;
  canMerge: boolean;
  issues: string[];
};

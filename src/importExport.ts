import { db, uid } from './db';
import { blobToDataUrl, dataUrlToBlob, optimizeImageBlob, urlToBlob } from './media';
import { sanitizeRichText } from './richText';
import {
  AppSettings,
  BackupBundle,
  Card,
  Deck,
  DeckSettings,
  ImportBundle,
  ImportMode,
  ImportMedia,
  ImportPreview,
  MediaAsset,
} from './types';
import { createInitialSrs } from './srs';

const DEFAULT_SETTINGS: DeckSettings = {
  showQuestionText: true,
  showQuestionImage: true,
};

export const createBackup = async (): Promise<BackupBundle> => {
  const [decks, cards, media, settings] = await Promise.all([db.getDecks(), db.getCards(), db.getMedia(), db.getSettings()]);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    decks,
    cards,
    media: await Promise.all(
      media.map(async (asset) => ({
        id: asset.id,
        type: asset.type,
        mimeType: asset.mimeType,
        dataUrl: await blobToDataUrl(asset.blob),
        createdAt: asset.createdAt,
      })),
    ),
    settings,
  };
};

export const downloadJson = (value: unknown, filename: string) => {
  const blob = new Blob([JSON.stringify(value)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

export const parseImportFile = async (file: File): Promise<ImportPreview> => {
  const parsed = JSON.parse(await file.text()) as ImportBundle | BackupBundle;
  const decks = await db.getDecks();

  if ('decks' in parsed && 'exportedAt' in parsed) {
    return {
      bundle: parsed,
      kind: 'backup',
      title: 'Memorizer backup',
      cardCount: parsed.cards?.length ?? 0,
      mediaCount: parsed.media?.length ?? 0,
      canMerge: false,
      issues: validateBackup(parsed),
    };
  }

  const title = parsed.deck?.title ?? '';
  const existingDeck = decks.find((deck) => deck.title.trim().toLowerCase() === title.trim().toLowerCase());
  const issues = validateImportBundle(parsed);

  return {
    bundle: parsed,
    kind: 'deck',
    title,
    cardCount: parsed.cards?.length ?? 0,
    mediaCount: parsed.media?.length ?? 0,
    existingDeckId: existingDeck?.id,
    canMerge: Boolean(parsed.cards?.length && parsed.cards.every((card) => card.id)),
    issues,
  };
};

const validateImportBundle = (bundle: ImportBundle): string[] => {
  const issues: string[] = [];
  if (bundle.version !== 1) issues.push('Unsupported version.');
  if (!bundle.deck?.title) issues.push('Deck title is required.');
  if (!Array.isArray(bundle.cards)) issues.push('Cards must be an array.');
  bundle.cards?.forEach((card, index) => {
    if (!card.questionText && !card.questionImageId) issues.push(`Card ${index + 1}: question text or image is required.`);
    if (!card.answerText) issues.push(`Card ${index + 1}: answer text is required.`);
  });
  return issues;
};

const validateBackup = (bundle: BackupBundle): string[] => {
  const issues: string[] = [];
  if (bundle.version !== 1) issues.push('Unsupported backup version.');
  if (!Array.isArray(bundle.decks) || !Array.isArray(bundle.cards) || !Array.isArray(bundle.media)) {
    issues.push('Backup is missing decks, cards, or media.');
  }
  return issues;
};

const materializeMedia = async (media: ImportMedia[] = []): Promise<MediaAsset[]> =>
  Promise.all(
    media.map(async (item) => {
      const result = item.dataUrl ? await dataUrlToBlob(item.dataUrl) : item.url ? await urlToBlob(item.url) : undefined;
      if (!result) throw new Error(`Media ${item.id} has no dataUrl or url.`);
      const optimized = item.type === 'image' ? await optimizeImageBlob(result.blob) : undefined;
      return {
        id: item.id,
        type: item.type,
        mimeType: optimized?.mimeType ?? item.mimeType ?? result.mimeType,
        blob: optimized?.blob ?? result.blob,
        createdAt: item.createdAt ?? new Date().toISOString(),
      };
    }),
  );

export const applyImport = async (preview: ImportPreview, mode: ImportMode): Promise<void> => {
  if (preview.issues.length) throw new Error(preview.issues[0]);

  if (preview.kind === 'backup') {
    const backup = preview.bundle as BackupBundle;
    await db.replaceAll(
      backup.decks,
      backup.cards,
      await materializeMedia(backup.media),
      backup.settings as AppSettings,
    );
    return;
  }

  const bundle = preview.bundle as ImportBundle;
  const now = new Date().toISOString();
  const existingDeckId = preview.existingDeckId;
  const targetDeckId = mode === 'copy' || !existingDeckId ? uid('deck') : existingDeckId;
  const media = await materializeMedia(bundle.media);

  if (mode === 'replace' && existingDeckId) {
    await db.deleteDeck(existingDeckId);
  }

  const deck: Deck = {
    id: targetDeckId,
    title: mode === 'copy' && existingDeckId ? `${bundle.deck.title} copy` : bundle.deck.title,
    description: bundle.deck.description ?? '',
    coverImageId: bundle.deck.coverImageId,
    locale: bundle.deck.locale ?? 'ru',
    tags: bundle.deck.tags ?? [],
    settings: { ...DEFAULT_SETTINGS, ...bundle.deck.settings },
    createdAt: now,
    updatedAt: now,
  };

  await Promise.all(media.map((asset) => db.saveMedia(asset)));
  await db.saveDeck(deck);

  if (mode === 'merge' && existingDeckId) {
    const existingCards = await db.getCardsByDeck(existingDeckId);
    const existingById = new Map(existingCards.map((card) => [card.id, card]));
    await Promise.all(
      bundle.cards.map((item) => {
        const card: Card = {
          ...(existingById.get(item.id ?? '') ?? {
            id: item.id ?? uid('card'),
            deckId: targetDeckId,
            srs: createInitialSrs(),
            createdAt: now,
          }),
          deckId: targetDeckId,
          questionText: item.questionText ?? '',
          questionImageId: item.questionImageId,
          answerText: sanitizeRichText(item.answerText ?? ''),
          answerAudioId: item.answerAudioId,
          updatedAt: now,
        };
        return db.saveCard(card);
      }),
    );
    return;
  }

  await Promise.all(
    bundle.cards.map((item) =>
      db.saveCard({
        id: mode === 'copy' ? uid('card') : item.id ?? uid('card'),
        deckId: targetDeckId,
        questionText: item.questionText ?? '',
        questionImageId: item.questionImageId,
        answerText: sanitizeRichText(item.answerText ?? ''),
        answerAudioId: item.answerAudioId,
        srs: createInitialSrs(),
        createdAt: now,
        updatedAt: now,
      }),
    ),
  );
};

import { db } from './db';
import { blobToDataUrl, dataUrlToBlob, optimizeImageBlob } from './media';
import { sanitizeRichText } from './richText';
import { Card, Deck, MediaAsset, SyncBundle, SyncCard, SyncSettings } from './types';
import { createInitialSrs } from './srs';

type GitHubFileMetadata = {
  sha: string;
};

export type SyncResult = {
  decks: number;
  cards: number;
  media: number;
};

const apiUrlForPath = (settings: SyncSettings, path: string) =>
  `https://api.github.com/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/contents/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

const apiUrl = (settings: SyncSettings) => apiUrlForPath(settings, settings.path);

const githubHeaders = (settings: SyncSettings, accept = 'application/vnd.github+json') => ({
  Accept: accept,
  Authorization: `Bearer ${settings.token}`,
  'X-GitHub-Api-Version': '2022-11-28',
});

const assertConfigured = (settings: SyncSettings) => {
  if (!settings.token.trim()) throw new Error('GitHub token is required.');
  if (!settings.owner.trim() || !settings.repo.trim() || !settings.branch.trim() || !settings.path.trim()) {
    throw new Error('GitHub sync settings are incomplete.');
  }
};

const bytesToBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }

  return btoa(binary);
};

const getRemoteMetadata = async (settings: SyncSettings): Promise<GitHubFileMetadata | undefined> => {
  const response = await fetch(`${apiUrl(settings)}?ref=${encodeURIComponent(settings.branch)}`, {
    headers: githubHeaders(settings),
  });

  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub metadata request failed: ${response.status}`);
  return response.json() as Promise<GitHubFileMetadata>;
};

const putGitHubFile = async (settings: SyncSettings, path: string, content: string, message: string, sha?: string) => {
  const response = await fetch(apiUrlForPath(settings, path), {
    method: 'PUT',
    headers: {
      ...githubHeaders(settings),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      branch: settings.branch,
      content: bytesToBase64(content),
      sha,
    }),
  });

  if (!response.ok) throw new Error(`GitHub upload failed: ${response.status}`);
};

const getRemoteBundle = async (settings: SyncSettings): Promise<SyncBundle | undefined> => {
  const response = await fetch(`${apiUrl(settings)}?ref=${encodeURIComponent(settings.branch)}`, {
    headers: githubHeaders(settings, 'application/vnd.github.raw+json'),
  });

  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub download failed: ${response.status}`);
  return response.json() as Promise<SyncBundle>;
};

export const createSyncBundle = async (): Promise<SyncBundle> => {
  const [decks, cards, media] = await Promise.all([db.getDecks(), db.getCards(), db.getMedia()]);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    decks,
    cards: cards.map(({ srs: _srs, ...card }) => card),
    media: await Promise.all(
      media.map(async (asset) => ({
        id: asset.id,
        type: asset.type,
        mimeType: asset.mimeType,
        dataUrl: await blobToDataUrl(asset.blob),
        createdAt: asset.createdAt,
      })),
    ),
  };
};

export const pushSyncBundle = async (settings: SyncSettings): Promise<SyncResult> => {
  assertConfigured(settings);
  const [bundle, metadata, remoteBundle] = await Promise.all([createSyncBundle(), getRemoteMetadata(settings), getRemoteBundle(settings)]);
  const timestamp = new Date().toISOString();

  if (remoteBundle) {
    const backupPath = `backups/${timestamp.replace(/[:.]/g, '-')}-${settings.path.split('/').pop() ?? 'memorizer-sync.json'}`;
    await putGitHubFile(settings, backupPath, JSON.stringify(remoteBundle), `Backup Memorizer sync before ${timestamp}`);
  }

  await putGitHubFile(settings, settings.path, JSON.stringify(bundle), `Update Memorizer sync ${timestamp}`, metadata?.sha);
  return { decks: bundle.decks.length, cards: bundle.cards.length, media: bundle.media.length };
};

const materializeSyncMedia = async (media: SyncBundle['media']): Promise<MediaAsset[]> =>
  Promise.all(
    media.map(async (item) => {
      const result = await dataUrlToBlob(item.dataUrl);
      const optimized = item.type === 'image' ? await optimizeImageBlob(result.blob) : undefined;

      return {
        id: item.id,
        type: item.type,
        mimeType: optimized?.mimeType ?? item.mimeType ?? result.mimeType,
        blob: optimized?.blob ?? result.blob,
        createdAt: item.createdAt,
      };
    }),
  );

const mergeDecks = (incoming: Deck[], existing: Deck[]) => {
  const existingById = new Map(existing.map((deck) => [deck.id, deck]));
  const existingByTitle = new Map(existing.map((deck) => [deck.title.trim().toLowerCase(), deck]));
  const deckIdMap = new Map<string, string>();

  const decks = incoming.map((deck) => {
    const matched = existingById.get(deck.id) ?? existingByTitle.get(deck.title.trim().toLowerCase());
    const targetId = matched?.id ?? deck.id;
    deckIdMap.set(deck.id, targetId);

    return {
      ...deck,
      id: targetId,
      createdAt: matched?.createdAt ?? deck.createdAt,
      updatedAt: deck.updatedAt,
    };
  });

  return { decks, deckIdMap };
};

const mergeCards = (incoming: SyncCard[], existing: Card[], deckIdMap: Map<string, string>) => {
  const existingById = new Map(existing.map((card) => [card.id, card]));

  return incoming.map((card) => {
    const matched = existingById.get(card.id);

    return {
      ...card,
      deckId: deckIdMap.get(card.deckId) ?? card.deckId,
      answerText: sanitizeRichText(card.answerText),
      srs: matched?.srs ?? createInitialSrs(),
      createdAt: matched?.createdAt ?? card.createdAt,
      updatedAt: card.updatedAt,
    };
  });
};

export const pullSyncBundle = async (settings: SyncSettings): Promise<SyncResult> => {
  assertConfigured(settings);
  const bundle = await getRemoteBundle(settings);
  if (!bundle) throw new Error('Sync file does not exist yet. Push from your computer first.');

  const [existingDecks, existingCards, media] = await Promise.all([
    db.getDecks(),
    db.getCards(),
    materializeSyncMedia(bundle.media ?? []),
  ]);
  const { decks, deckIdMap } = mergeDecks(bundle.decks ?? [], existingDecks);
  const cards = mergeCards(bundle.cards ?? [], existingCards, deckIdMap);

  await Promise.all(media.map((asset) => db.saveMedia(asset)));
  await Promise.all(decks.map((deck) => db.saveDeck(deck)));
  await Promise.all(cards.map((card) => db.saveCard(card)));

  return { decks: decks.length, cards: cards.length, media: media.length };
};

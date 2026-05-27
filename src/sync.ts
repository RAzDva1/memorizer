import { db } from './db';
import { blobToDataUrl, dataUrlToBlob, optimizeImageBlob } from './media';
import { sanitizeRichText } from './richText';
import { Card, Deck, MediaAsset, SyncBundle, SyncCard, SyncSettings } from './types';
import { createInitialSrs } from './srs';

type GitHubRef = {
  object: {
    sha: string;
  };
};

type GitHubCommit = {
  sha: string;
  tree: {
    sha: string;
  };
};

type GitHubCreatedObject = {
  sha: string;
};

type GitHubContentItem = {
  name: string;
  path: string;
  type: string;
};

export type SyncResult = {
  decks: number;
  cards: number;
  media: number;
};

const MAX_SYNC_BACKUPS = 2;

const apiUrlForPath = (settings: SyncSettings, path: string) =>
  `https://api.github.com/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/contents/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

const apiUrl = (settings: SyncSettings) => apiUrlForPath(settings, settings.path);

const gitApiUrl = (settings: SyncSettings, path: string) =>
  `https://api.github.com/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/git/${path}`;

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

const readGitHubError = async (response: Response, label: string) => {
  let detail = '';

  try {
    const body = await response.json();
    const errors = Array.isArray(body.errors)
      ? body.errors
          .map((error: { message?: string; code?: string; field?: string }) => error.message ?? error.code ?? error.field)
          .filter(Boolean)
          .join('; ')
      : '';
    detail = [body.message, errors].filter(Boolean).join(': ');
  } catch {
    detail = await response.text().catch(() => '');
  }

  throw new Error(`${label}: ${response.status}${detail ? ` (${detail})` : ''}`);
};

const getBranchHead = async (settings: SyncSettings): Promise<GitHubCommit> => {
  const refResponse = await fetch(gitApiUrl(settings, `ref/heads/${encodeURIComponent(settings.branch)}`), {
    headers: githubHeaders(settings),
  });

  if (!refResponse.ok) await readGitHubError(refResponse, 'GitHub branch request failed');
  const ref = (await refResponse.json()) as GitHubRef;

  const commitResponse = await fetch(gitApiUrl(settings, `commits/${ref.object.sha}`), {
    headers: githubHeaders(settings),
  });

  if (!commitResponse.ok) await readGitHubError(commitResponse, 'GitHub commit request failed');
  return commitResponse.json() as Promise<GitHubCommit>;
};

const createGitBlob = async (settings: SyncSettings, content: string): Promise<string> => {
  const response = await fetch(gitApiUrl(settings, 'blobs'), {
    method: 'POST',
    headers: {
      ...githubHeaders(settings),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: bytesToBase64(content),
      encoding: 'base64',
    }),
  });

  if (!response.ok) await readGitHubError(response, 'GitHub blob upload failed');
  return ((await response.json()) as GitHubCreatedObject).sha;
};

const commitGitFiles = async (
  settings: SyncSettings,
  files: Array<{ path: string; content: string }>,
  deletePaths: string[],
  message: string,
) => {
  const head = await getBranchHead(settings);
  const blobs = await Promise.all(files.map(async (file) => ({ ...file, sha: await createGitBlob(settings, file.content) })));
  const treeItems = [
    ...blobs.map((blob) => ({
      path: blob.path.replace(/^\/+/, ''),
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    })),
    ...deletePaths.map((path) => ({
      path: path.replace(/^\/+/, ''),
      mode: '100644',
      type: 'blob',
      sha: null,
    })),
  ];
  const treeResponse = await fetch(gitApiUrl(settings, 'trees'), {
    method: 'POST',
    headers: {
      ...githubHeaders(settings),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      base_tree: head.tree.sha,
      tree: treeItems,
    }),
  });

  if (!treeResponse.ok) await readGitHubError(treeResponse, 'GitHub tree update failed');
  const tree = (await treeResponse.json()) as GitHubCreatedObject;
  const commitResponse = await fetch(gitApiUrl(settings, 'commits'), {
    method: 'POST',
    headers: {
      ...githubHeaders(settings),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [head.sha],
    }),
  });

  if (!commitResponse.ok) await readGitHubError(commitResponse, 'GitHub commit failed');
  const commit = (await commitResponse.json()) as GitHubCreatedObject;
  const refResponse = await fetch(gitApiUrl(settings, `refs/heads/${encodeURIComponent(settings.branch)}`), {
    method: 'PATCH',
    headers: {
      ...githubHeaders(settings),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sha: commit.sha,
      force: false,
    }),
  });

  if (!refResponse.ok) await readGitHubError(refResponse, 'GitHub branch update failed');
};

const getRemoteBundle = async (settings: SyncSettings): Promise<SyncBundle | undefined> => {
  const response = await fetch(`${apiUrl(settings)}?ref=${encodeURIComponent(settings.branch)}`, {
    headers: githubHeaders(settings, 'application/vnd.github.raw+json'),
  });

  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub download failed: ${response.status}`);
  return response.json() as Promise<SyncBundle>;
};

const getRemoteBackups = async (settings: SyncSettings): Promise<GitHubContentItem[]> => {
  const response = await fetch(`${apiUrlForPath(settings, 'backups')}?ref=${encodeURIComponent(settings.branch)}`, {
    headers: githubHeaders(settings),
  });

  if (response.status === 404) return [];
  if (!response.ok) await readGitHubError(response, 'GitHub backups request failed');
  const result = await response.json();

  return Array.isArray(result) ? result.filter((item): item is GitHubContentItem => item.type === 'file') : [];
};

const backupCleanupPaths = (existingBackups: GitHubContentItem[], newBackupPath?: string) => {
  const nextBackups = [
    ...existingBackups.map((backup) => ({ path: backup.path, name: backup.name })),
    ...(newBackupPath ? [{ path: newBackupPath, name: newBackupPath.split('/').pop() ?? newBackupPath }] : []),
  ];
  const keep = new Set(
    nextBackups
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, MAX_SYNC_BACKUPS)
      .map((backup) => backup.path),
  );

  return existingBackups.map((backup) => backup.path).filter((path) => !keep.has(path));
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
  const [bundle, remoteBundle, existingBackups] = await Promise.all([
    createSyncBundle(),
    getRemoteBundle(settings),
    getRemoteBackups(settings),
  ]);
  const timestamp = new Date().toISOString();
  const files = [{ path: settings.path, content: JSON.stringify(bundle) }];
  let backupPath: string | undefined;

  if (remoteBundle) {
    backupPath = `backups/${timestamp.replace(/[:.]/g, '-')}-${settings.path.split('/').pop() ?? 'memorizer-sync.json'}`;
    files.push({ path: backupPath, content: JSON.stringify(remoteBundle) });
  }

  await commitGitFiles(settings, files, backupCleanupPaths(existingBackups, backupPath), `Update Memorizer sync ${timestamp}`);
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

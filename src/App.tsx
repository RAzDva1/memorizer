import {
  ArrowLeft,
  BookOpen,
  Check,
  Download,
  Ellipsis,
  FileUp,
  Image,
  ImageOff,
  Layers,
  Library,
  ListRestart,
  Pencil,
  Play,
  Plus,
  Save,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  UploadCloud,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react';
import {
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  FormEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { db, uid } from './db';
import { dictionaries, TranslationKey } from './i18n';
import { applyImport, createBackup, downloadJson, parseImportFile } from './importExport';
import { fileToAsset, optimizeImageAsset } from './media';
import { hasRichTextContent, plainTextToRichText, sanitizeRichText, stripRichText } from './richText';
import { createInitialSrs, isDue, reviewCard } from './srs';
import { pullSyncBundle, pushSyncBundle } from './sync';
import { AppSettings, Card, Deck, DeckStats, ImportMode, ImportPreview, Locale, SyncSettings } from './types';

type Screen =
  | { name: 'training' }
  | { name: 'decks' }
  | { name: 'library' }
  | { name: 'more' }
  | { name: 'deck'; deckId: string }
  | { name: 'deckForm'; deckId?: string }
  | { name: 'cardForm'; deckId: string; cardId?: string }
  | { name: 'study'; deckId: string; mode?: 'due' | 'all' };

const defaultDeckSettings = { showQuestionText: true, showQuestionImage: true };

const nowIso = () => new Date().toISOString();

const byCreatedAt = <T extends { createdAt: string }>(a: T, b: T) => a.createdAt.localeCompare(b.createdAt);

const formatTags = (tags: string[]) => tags.join(', ');

type SwipeInput = 'pointer' | 'touch';
type SwipeMode = 'idle' | 'pending' | 'swipe' | 'scroll';

const parseTags = (value: string) =>
  value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const imageFromClipboard = (event: ReactClipboardEvent): File | undefined => {
  const item = Array.from(event.clipboardData.items).find((entry) => entry.kind === 'file' && entry.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (!file) return undefined;

  const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  return new File([file], file.name || `pasted-image-${Date.now()}.${extension}`, { type: file.type || 'image/png' });
};

const useMediaUrl = (id?: string) => {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;

    if (!id) {
      setUrl(undefined);
      return undefined;
    }

    db.getMediaAsset(id).then((asset) => {
      if (!active || !asset) return;
      objectUrl = URL.createObjectURL(asset.blob);
      setUrl(objectUrl);
    });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  return url;
};

export const App = () => {
  const [screen, setScreen] = useState<Screen>({ name: 'decks' });
  const [settings, setSettings] = useState<AppSettings>({ locale: 'ru' });
  const [decks, setDecks] = useState<Deck[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const t = (key: TranslationKey) => dictionaries[settings.locale][key];

  const refresh = () => setRefreshKey((key) => key + 1);

  useEffect(() => {
    Promise.all([db.getSettings(), db.getDecks(), db.getCards()]).then(([nextSettings, nextDecks, nextCards]) => {
      setSettings(nextSettings);
      setDecks(nextDecks.sort(byCreatedAt));
      setCards(nextCards.sort(byCreatedAt));
    });
  }, [refreshKey]);

  const stats = useMemo(() => buildStats(decks, cards), [decks, cards]);

  const updateSettings = async (next: AppSettings) => {
    setSettings(next);
    await db.saveSettings(next);
    refresh();
  };

  const currentDeck = 'deckId' in screen ? decks.find((deck) => deck.id === screen.deckId) : undefined;

  return (
    <div className="app-shell">
      <main className="app-main">
        {screen.name === 'training' && (
          <TrainingHome decks={decks} stats={stats} t={t} go={setScreen} />
        )}
        {screen.name === 'decks' && <DecksView decks={decks} stats={stats} t={t} go={setScreen} />}
        {screen.name === 'library' && <LibraryView t={t} refresh={refresh} />}
        {screen.name === 'more' && (
          <MoreView t={t} settings={settings} updateSettings={updateSettings} refresh={refresh} />
        )}
        {screen.name === 'deck' && currentDeck && (
          <DeckDetail
            deck={currentDeck}
            cards={cards.filter((card) => card.deckId === currentDeck.id).sort(byCreatedAt)}
            t={t}
            go={setScreen}
            refresh={refresh}
          />
        )}
        {screen.name === 'deckForm' && (
          <DeckForm
            deck={screen.deckId ? decks.find((deck) => deck.id === screen.deckId) : undefined}
            locale={settings.locale}
            t={t}
            done={(deckId) => setScreen(deckId ? { name: 'deck', deckId } : { name: 'decks' })}
            refresh={refresh}
          />
        )}
        {screen.name === 'cardForm' && (
          <CardForm
            deck={decks.find((deck) => deck.id === screen.deckId)}
            card={screen.cardId ? cards.find((card) => card.id === screen.cardId) : undefined}
            t={t}
            done={() => setScreen({ name: 'deck', deckId: screen.deckId })}
            refresh={refresh}
          />
        )}
        {screen.name === 'study' && currentDeck && (
          <StudyView
            key={`${currentDeck.id}-${screen.mode ?? 'due'}`}
            deck={currentDeck}
            cards={cards.filter((card) => card.deckId === currentDeck.id).sort(byCreatedAt)}
            mode={screen.mode ?? 'due'}
            t={t}
            back={() => setScreen({ name: 'deck', deckId: currentDeck.id })}
            refresh={refresh}
          />
        )}
      </main>
      {screen.name !== 'study' && <BottomNav screen={screen} t={t} go={setScreen} />}
    </div>
  );
};

const buildStats = (decks: Deck[], cards: Card[]) => {
  const map = new Map<string, DeckStats>();
  decks.forEach((deck) => map.set(deck.id, { total: 0, due: 0, learned: 0 }));
  cards.forEach((card) => {
    const item = map.get(card.deckId) ?? { total: 0, due: 0, learned: 0 };
    item.total += 1;
    if (isDue(card.srs)) item.due += 1;
    if (card.srs.reviewCount > 0) item.learned += 1;
    map.set(card.deckId, item);
  });
  return map;
};

const BottomNav = ({ screen, t, go }: { screen: Screen; t: (key: TranslationKey) => string; go: (screen: Screen) => void }) => {
  const items = [
    { name: 'training', label: t('training'), icon: Zap },
    { name: 'decks', label: t('decks'), icon: Layers },
    { name: 'library', label: t('library'), icon: BookOpen },
    { name: 'more', label: t('more'), icon: Ellipsis },
  ] as const;

  return (
    <nav className="bottom-nav">
      {items.map((item) => {
        const Icon = item.icon;
        const active = screen.name === item.name || (screen.name === 'deck' && item.name === 'decks');
        return (
          <button key={item.name} className={active ? 'nav-item active' : 'nav-item'} onClick={() => go({ name: item.name })}>
            <Icon size={26} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
};

const DecksView = ({
  decks,
  stats,
  t,
  go,
}: {
  decks: Deck[];
  stats: Map<string, DeckStats>;
  t: (key: TranslationKey) => string;
  go: (screen: Screen) => void;
}) => (
  <section className="screen">
    <header className="topbar large">
      <h1>{t('myDecks')}</h1>
      <button className="round primary" onClick={() => go({ name: 'deckForm' })} aria-label={t('newDeck')}>
        <Plus />
      </button>
    </header>
    {decks.length === 0 ? (
      <EmptyState label={t('noDecks')} icon={Layers} action={<button className="primary-button" onClick={() => go({ name: 'deckForm' })}>{t('newDeck')}</button>} />
    ) : (
      <div className="deck-grid">
        {decks.map((deck) => (
          <DeckTile key={deck.id} deck={deck} stats={stats.get(deck.id)} t={t} go={go} />
        ))}
      </div>
    )}
  </section>
);

const DeckTile = ({
  deck,
  stats,
  t,
  go,
}: {
  deck: Deck;
  stats?: DeckStats;
  t: (key: TranslationKey) => string;
  go: (screen: Screen) => void;
}) => {
  const coverUrl = useMediaUrl(deck.coverImageId);

  return (
    <article className="deck-tile" onClick={() => go({ name: 'deck', deckId: deck.id })}>
      <div className="deck-cover">
        {coverUrl ? <img src={coverUrl} alt="" /> : <div className="cover-placeholder"><Library /></div>}
        <button
          className="round small ghost menu-button"
          onClick={(event) => {
            event.stopPropagation();
            go({ name: 'deckForm', deckId: deck.id });
          }}
          aria-label={t('editDeck')}
        >
          <Ellipsis size={20} />
        </button>
        <button
          className="round play-button"
          onClick={(event) => {
            event.stopPropagation();
            go({ name: 'study', deckId: deck.id, mode: 'due' });
          }}
          aria-label={t('start')}
        >
          <Play fill="currentColor" />
        </button>
      </div>
      <div className="deck-tile-body">
        <h2>{deck.title}</h2>
        <p>{stats?.total ?? 0} {t('cardsCount')} · {stats?.due ?? 0} {t('due')}</p>
        <ProgressBar stats={stats} />
      </div>
    </article>
  );
};

const TrainingHome = ({
  decks,
  stats,
  t,
  go,
}: {
  decks: Deck[];
  stats: Map<string, DeckStats>;
  t: (key: TranslationKey) => string;
  go: (screen: Screen) => void;
}) => (
  <section className="screen">
    <header className="topbar large">
      <h1>{t('training')}</h1>
      <Sparkles className="muted-icon" />
    </header>
    <div className="list">
      {decks.map((deck) => {
        const item = stats.get(deck.id) ?? { total: 0, due: 0, learned: 0 };
        return (
          <button key={deck.id} className="training-row" onClick={() => go({ name: 'study', deckId: deck.id, mode: 'due' })}>
            <DeckThumb deck={deck} />
            <span>
              <strong>{deck.title}</strong>
              <small>{item.due} {t('due')} · {Math.round((item.learned / Math.max(1, item.total)) * 100)}%</small>
            </span>
            <Play size={22} />
          </button>
        );
      })}
    </div>
    {decks.length === 0 && <EmptyState label={t('noDecks')} icon={Zap} />}
  </section>
);

const DeckThumb = ({ deck }: { deck: Deck }) => {
  const coverUrl = useMediaUrl(deck.coverImageId);
  return <span className="thumb">{coverUrl ? <img src={coverUrl} alt="" /> : <Layers size={20} />}</span>;
};

const CardMediaBadges = ({ card, t }: { card: Card; t: (key: TranslationKey) => string }) => (
  <span className="media-badges">
    <span className={card.questionImageId ? 'media-badge active' : 'media-badge missing'} title={card.questionImageId ? t('hasImage') : t('noImage')}>
      {card.questionImageId ? <Image size={17} /> : <ImageOff size={17} />}
    </span>
    <span className={card.answerAudioId ? 'media-badge active' : 'media-badge missing'} title={card.answerAudioId ? t('hasAudio') : t('noAudio')}>
      {card.answerAudioId ? <Volume2 size={17} /> : <VolumeX size={17} />}
    </span>
  </span>
);

const DeckDetail = ({
  deck,
  cards,
  t,
  go,
  refresh,
}: {
  deck: Deck;
  cards: Card[];
  t: (key: TranslationKey) => string;
  go: (screen: Screen) => void;
  refresh: () => void;
}) => {
  const due = cards.filter((card) => isDue(card.srs)).length;
  const coverUrl = useMediaUrl(deck.coverImageId);
  const [isCoverOpen, setIsCoverOpen] = useState(false);

  const resetProgress = async () => {
    if (!confirm(t('resetProgressConfirm'))) return;
    const timestamp = nowIso();
    await Promise.all(cards.map((card) => db.saveCard({ ...card, srs: createInitialSrs(), updatedAt: timestamp })));
    refresh();
  };

  return (
    <section className="screen">
      <header className="topbar">
        <button className="icon-button" onClick={() => go({ name: 'decks' })} aria-label="Back"><ArrowLeft /></button>
        <h1>{deck.title}</h1>
        <button className="icon-button" onClick={() => go({ name: 'deckForm', deckId: deck.id })} aria-label={t('editDeck')}><Pencil /></button>
      </header>
      <div className="deck-hero">
        {coverUrl ? (
          <button className="deck-hero-cover" type="button" onClick={() => setIsCoverOpen(true)} aria-label={t('viewCover')}>
            <img src={coverUrl} alt="" />
          </button>
        ) : (
          <DeckThumb deck={deck} />
        )}
        <div>
          <p>{deck.description}</p>
          <small>{due} {t('due')} · {cards.length} {t('cardsCount')}</small>
        </div>
      </div>
      <div className="action-row">
        <button className="primary-button" onClick={() => go({ name: 'study', deckId: deck.id, mode: 'due' })}><Play />{t('start')}</button>
        <button className="secondary-button" onClick={() => go({ name: 'study', deckId: deck.id, mode: 'all' })}><ListRestart />{t('allCards')}</button>
      </div>
      <div className="action-row">
        <button className="secondary-button" onClick={() => go({ name: 'cardForm', deckId: deck.id })}><Plus />{t('newCard')}</button>
      </div>
      <section className="settings-panel">
        <h2>{t('settings')}</h2>
        <Toggle
          label={t('showText')}
          checked={deck.settings.showQuestionText}
          onChange={async (checked) => {
            await db.saveDeck({ ...deck, settings: { ...deck.settings, showQuestionText: checked }, updatedAt: nowIso() });
            refresh();
          }}
        />
        <Toggle
          label={t('showImage')}
          checked={deck.settings.showQuestionImage}
          onChange={async (checked) => {
            await db.saveDeck({ ...deck, settings: { ...deck.settings, showQuestionImage: checked }, updatedAt: nowIso() });
            refresh();
          }}
        />
        <button className="danger-button wide" onClick={resetProgress}>
          <ListRestart />
          {t('resetProgress')}
        </button>
      </section>
      <div className="list">
        {cards.map((card) => (
          <button key={card.id} className="card-row" onClick={() => go({ name: 'cardForm', deckId: deck.id, cardId: card.id })}>
            <span>
              <strong>{card.questionText || t('questionImage')}</strong>
              <small>{stripRichText(card.answerText)}</small>
            </span>
            <span className="card-row-actions">
              <CardMediaBadges card={card} t={t} />
              <Pencil size={18} />
            </span>
          </button>
        ))}
        {cards.length === 0 && <EmptyState label={t('noCards')} icon={Library} />}
      </div>
      {isCoverOpen && coverUrl && (
        <div className="image-viewer" role="dialog" aria-modal="true" onClick={() => setIsCoverOpen(false)}>
          <button className="round ghost image-viewer-close" type="button" onClick={() => setIsCoverOpen(false)} aria-label={t('closePreview')}>
            <X />
          </button>
          <img src={coverUrl} alt="" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </section>
  );
};

const DeckForm = ({
  deck,
  locale,
  t,
  done,
  refresh,
}: {
  deck?: Deck;
  locale: Locale;
  t: (key: TranslationKey) => string;
  done: (deckId?: string) => void;
  refresh: () => void;
}) => {
  const [title, setTitle] = useState(deck?.title ?? '');
  const [description, setDescription] = useState(deck?.description ?? '');
  const [deckLocale, setDeckLocale] = useState<Locale>(deck?.locale ?? locale);
  const [tags, setTags] = useState(formatTags(deck?.tags ?? []));
  const [cover, setCover] = useState<File>();
  const [error, setError] = useState('');
  const coverUrl = useMediaUrl(deck?.coverImageId);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setError(t('validationTitle'));
      return;
    }

    let coverImageId = deck?.coverImageId;
    if (cover) {
      const asset = await fileToAsset(cover, 'image');
      coverImageId = asset.id;
      await db.saveMedia(asset);
    }

    const timestamp = nowIso();
    const nextDeck: Deck = {
      id: deck?.id ?? uid('deck'),
      title: title.trim(),
      description: description.trim(),
      coverImageId,
      locale: deckLocale,
      tags: parseTags(tags),
      settings: deck?.settings ?? defaultDeckSettings,
      createdAt: deck?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    await db.saveDeck(nextDeck);
    refresh();
    done(nextDeck.id);
  };

  const pasteCover = (event: ReactClipboardEvent) => {
    const image = imageFromClipboard(event);
    if (!image) return;
    event.preventDefault();
    setCover(image);
  };

  const remove = async () => {
    if (!deck || !confirm(t('delete'))) return;
    await db.deleteDeck(deck.id);
    refresh();
    done();
  };

  return (
    <section className="screen">
      <header className="topbar">
        <button className="icon-button" onClick={() => done(deck?.id)} aria-label="Back"><ArrowLeft /></button>
        <h1>{deck ? t('editDeck') : t('newDeck')}</h1>
        <span />
      </header>
      <form className="form" onSubmit={save} onPaste={pasteCover}>
        <label>{t('title')}<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} /></label>
        <label>{t('description')}<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>
        <label>{t('tags')}<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="language, video, ideas" /></label>
        <label>{t('language')}
          <select value={deckLocale} onChange={(event) => setDeckLocale(event.target.value as Locale)}>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </label>
        <FilePicker label={t('cover')} accept="image/*" icon={Image} onChange={setCover} />
        {(cover || coverUrl) && <img className="form-preview" src={cover ? URL.createObjectURL(cover) : coverUrl} alt="" />}
        {error && <p className="error">{error}</p>}
        <div className="action-row">
          <button className="primary-button" type="submit"><Save />{t('save')}</button>
          {deck && <button className="danger-button" type="button" onClick={remove}><Trash2 />{t('delete')}</button>}
        </div>
      </form>
    </section>
  );
};

const CardForm = ({
  deck,
  card,
  t,
  done,
  refresh,
}: {
  deck?: Deck;
  card?: Card;
  t: (key: TranslationKey) => string;
  done: () => void;
  refresh: () => void;
}) => {
  const [questionText, setQuestionText] = useState(card?.questionText ?? '');
  const [answerText, setAnswerText] = useState(card?.answerText ?? '');
  const [questionImage, setQuestionImage] = useState<File>();
  const [answerAudio, setAnswerAudio] = useState<File>();
  const [error, setError] = useState('');
  const imageUrl = useMediaUrl(card?.questionImageId);
  const audioUrl = useMediaUrl(card?.answerAudioId);

  if (!deck) return null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!questionText.trim() && !questionImage && !card?.questionImageId) {
      setError(t('validationQuestion'));
      return;
    }
    if (!hasRichTextContent(answerText)) {
      setError(t('validationAnswer'));
      return;
    }

    let questionImageId = card?.questionImageId;
    let answerAudioId = card?.answerAudioId;

    if (questionImage) {
      const asset = await fileToAsset(questionImage, 'image');
      questionImageId = asset.id;
      await db.saveMedia(asset);
    }

    if (answerAudio) {
      const asset = await fileToAsset(answerAudio, 'audio');
      answerAudioId = asset.id;
      await db.saveMedia(asset);
    }

    const timestamp = nowIso();
    await db.saveCard({
      id: card?.id ?? uid('card'),
      deckId: deck.id,
      questionText: questionText.trim(),
      questionImageId,
      answerText: sanitizeRichText(answerText),
      answerAudioId,
      srs: card?.srs ?? createInitialSrs(),
      createdAt: card?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    refresh();
    done();
  };

  const pasteQuestionImage = (event: ReactClipboardEvent) => {
    const image = imageFromClipboard(event);
    if (!image) return;
    event.preventDefault();
    setQuestionImage(image);
  };

  const remove = async () => {
    if (!card || !confirm(t('delete'))) return;
    await db.deleteCard(card.id);
    refresh();
    done();
  };

  return (
    <section className="screen">
      <header className="topbar">
        <button className="icon-button" onClick={done} aria-label="Back"><ArrowLeft /></button>
        <h1>{card ? t('editCard') : t('newCard')}</h1>
        <span />
      </header>
      <form className="form" onSubmit={save} onPaste={pasteQuestionImage}>
        <label>{t('questionText')}<textarea value={questionText} onChange={(event) => setQuestionText(event.target.value)} rows={3} maxLength={240} /></label>
        <FilePicker label={t('questionImage')} accept="image/*" icon={Image} onChange={setQuestionImage} />
        {(questionImage || imageUrl) && <img className="form-preview" src={questionImage ? URL.createObjectURL(questionImage) : imageUrl} alt="" />}
        <RichTextEditor label={t('answerText')} value={answerText} onChange={setAnswerText} />
        <FilePicker label={t('answerAudio')} accept="audio/*" icon={Volume2} onChange={setAnswerAudio} />
        {(answerAudio || audioUrl) && <audio controls src={answerAudio ? URL.createObjectURL(answerAudio) : audioUrl} />}
        {error && <p className="error">{error}</p>}
        <div className="action-row">
          <button className="primary-button" type="submit"><Save />{t('save')}</button>
          {card && <button className="danger-button" type="button" onClick={remove}><Trash2 />{t('delete')}</button>}
        </div>
      </form>
    </section>
  );
};

const StudyView = ({
  deck,
  cards,
  mode,
  t,
  back,
  refresh,
}: {
  deck: Deck;
  cards: Card[];
  mode: 'due' | 'all';
  t: (key: TranslationKey) => string;
  back: () => void;
  refresh: () => void;
}) => {
  const [queue, setQueue] = useState(() =>
    (mode === 'all' ? cards : cards.filter((card) => isDue(card.srs))).sort((a, b) => a.srs.dueAt.localeCompare(b.srs.dueAt)),
  );
  const [flipped, setFlipped] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [last, setLast] = useState<Card | undefined>();
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [swipeFeedback, setSwipeFeedback] = useState<'remember' | 'hard' | undefined>();
  const startPointRef = useRef<{ x: number; y: number } | undefined>();
  const flippedRef = useRef(false);
  const currentRef = useRef<Card | undefined>();
  const didDragRef = useRef(false);
  const swipeModeRef = useRef<SwipeMode>('idle');
  const swipeInputRef = useRef<SwipeInput | undefined>();
  const lastSwipePointRef = useRef<{ x: number; y: number } | undefined>();
  const current = queue[0];
  const imageUrl = useMediaUrl(current?.questionImageId);
  const audioUrl = useMediaUrl(current?.answerAudioId);

  flippedRef.current = flipped;
  currentRef.current = current;

  const answer = async (remembered: boolean, animate = false) => {
    const targetCard = currentRef.current;
    if (!targetCard) return;

    if (animate) {
      setSwipeFeedback(remembered ? 'remember' : 'hard');
      setDrag({ x: remembered ? 420 : -420, y: 10 });
      await new Promise((resolve) => window.setTimeout(resolve, 190));
    }

    setLast(targetCard);
    await db.saveCard({ ...targetCard, srs: reviewCard(targetCard.srs, remembered), updatedAt: nowIso() });
    setQueue((items) => items.slice(1));
    setDoneCount((count) => count + 1);
    setFlipped(false);
    setDrag({ x: 0, y: 0 });
    setSwipeFeedback(undefined);
    refresh();
  };

  const restartAll = () => {
    setQueue([...cards].sort((a, b) => a.srs.dueAt.localeCompare(b.srs.dueAt)));
    setDoneCount(0);
    setFlipped(false);
    setLast(undefined);
    setDrag({ x: 0, y: 0 });
    setSwipeFeedback(undefined);
  };

  const undo = async () => {
    if (!last) return;
    await db.saveCard(last);
    setQueue((items) => [last, ...items]);
    setDoneCount((count) => Math.max(0, count - 1));
    setLast(undefined);
    setDrag({ x: 0, y: 0 });
    setSwipeFeedback(undefined);
    refresh();
  };

  const cancelSwipe = () => {
    startPointRef.current = undefined;
    swipeModeRef.current = 'idle';
    swipeInputRef.current = undefined;
    lastSwipePointRef.current = undefined;
    setDrag({ x: 0, y: 0 });
    setSwipeFeedback(undefined);
  };

  const beginSwipe = (input: SwipeInput, x: number, y: number) => {
    startPointRef.current = { x, y };
    swipeInputRef.current = input;
    swipeModeRef.current = 'pending';
    lastSwipePointRef.current = { x, y };
    didDragRef.current = false;
    setDrag({ x: 0, y: 0 });
    setSwipeFeedback(undefined);
  };

  const finishSwipe = (input: SwipeInput, x: number, y: number) => {
    const origin = startPointRef.current;
    if (swipeInputRef.current && swipeInputRef.current !== input) return;
    if (!origin) return;
    const deltaX = x - origin.x;
    const wasSwipe = swipeModeRef.current === 'swipe' || (swipeModeRef.current === 'pending' && Math.abs(deltaX) > 48);
    startPointRef.current = undefined;
    swipeModeRef.current = 'idle';
    swipeInputRef.current = undefined;
    lastSwipePointRef.current = undefined;
    setDrag({ x: 0, y: 0 });
    if (!wasSwipe || Math.abs(deltaX) < 48 || !flippedRef.current) {
      setSwipeFeedback(undefined);
      return;
    }
    navigator.vibrate?.(12);
    void answer(deltaX > 0, true);
  };

  const moveSwipe = (input: SwipeInput, x: number, y: number, stopNativeScroll?: () => void) => {
    const origin = startPointRef.current;
    if (swipeInputRef.current && swipeInputRef.current !== input) return;
    if (!origin || !flippedRef.current) return;
    const deltaX = x - origin.x;
    const deltaY = y - origin.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    if (absX > 8 || absY > 8) {
      didDragRef.current = true;
    }

    if (swipeModeRef.current === 'pending' && Math.max(absX, absY) > 10) {
      if (absX > absY * 0.9) {
        swipeModeRef.current = 'swipe';
      } else if (absY > absX * 1.2) {
        swipeModeRef.current = 'scroll';
      }
    }

    if (swipeModeRef.current === 'scroll') {
      setDrag({ x: 0, y: 0 });
      setSwipeFeedback(undefined);
      return;
    }

    if (swipeModeRef.current !== 'swipe') return;
    stopNativeScroll?.();
    lastSwipePointRef.current = { x, y };
    const nextX = Math.max(-140, Math.min(140, deltaX));
    setDrag({
      x: nextX,
      y: Math.max(-28, Math.min(28, deltaY)),
    });
    setSwipeFeedback(Math.abs(nextX) > 34 ? (nextX > 0 ? 'remember' : 'hard') : undefined);
  };

  useEffect(() => {
    const handleTouchMove = (event: globalThis.TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      moveSwipe('touch', touch.clientX, touch.clientY, () => event.preventDefault());
    };
    const handleTouchEnd = (event: globalThis.TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch) return;
      finishSwipe('touch', touch.clientX, touch.clientY);
    };
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'touch') return;
      moveSwipe('pointer', event.clientX, event.clientY, () => event.preventDefault());
    };
    const handlePointerUp = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'touch') return;
      finishSwipe('pointer', event.clientX, event.clientY);
    };
    const handlePointerCancel = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'touch') return;
      finishSwipe('pointer', event.clientX, event.clientY);
    };
    const handleTouchCancel = () => {
      const point = lastSwipePointRef.current;
      if (point) {
        finishSwipe('touch', point.x, point.y);
        return;
      }
      cancelSwipe();
    };

    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });
    document.addEventListener('touchcancel', handleTouchCancel);
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerCancel);

    return () => {
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchCancel);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerCancel);
    };
  });

  return (
    <section className="screen study-screen">
      <header className="topbar">
        <button className="icon-button" onClick={back} aria-label="Back"><ArrowLeft /></button>
        <h1>{deck.title}</h1>
        <button className="icon-button" onClick={undo} disabled={!last} aria-label={t('undo')}><ListRestart /></button>
      </header>
      {!current ? (
        <div className="finish-card">
          <Check size={48} />
          <h2>{doneCount ? t('finished') : t('emptyTraining')}</h2>
          <p>{doneCount} {t('doneToday')}</p>
          <div className="action-row compact">
            <button className="primary-button" onClick={back}>{t('decks')}</button>
            <button className="secondary-button" onClick={restartAll}>{t('allCards')}</button>
          </div>
        </div>
      ) : (
        <>
          <button
            className={[
              flipped ? 'study-card flipped' : 'study-card',
              swipeFeedback ? `swipe-${swipeFeedback}` : '',
            ].join(' ')}
            style={{
              transform: flipped ? `translate3d(${drag.x}px, ${drag.y}px, 0) rotate(${drag.x / 18}deg)` : undefined,
            }}
            onClick={() => {
              if (didDragRef.current) {
                didDragRef.current = false;
                return;
              }
              setFlipped((value) => !value);
            }}
            onPointerDown={(event) => {
              if (event.pointerType === 'touch') return;
              beginSwipe('pointer', event.clientX, event.clientY);
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerCancel={(event) => {
              if (event.pointerType !== 'touch') cancelSwipe();
            }}
            onTouchStart={(event) => {
              const touch = event.touches[0];
              if (touch) beginSwipe('touch', touch.clientX, touch.clientY);
            }}
          >
            {!flipped ? (
              <span className="study-front">
                {deck.settings.showQuestionImage && imageUrl && <img src={imageUrl} alt="" />}
                {deck.settings.showQuestionText && current.questionText && <strong>{current.questionText}</strong>}
              </span>
            ) : (
              <span className="study-back">
                {swipeFeedback && (
                  <span className="swipe-badge">
                    {swipeFeedback === 'remember' ? <Check size={20} /> : <X size={20} />}
                    {swipeFeedback === 'remember' ? t('remember') : t('hard')}
                  </span>
                )}
                <span className="answer-scroll">
                  {imageUrl && <img className="mini-image" src={imageUrl} alt="" />}
                  <span className="rich-answer" dangerouslySetInnerHTML={{ __html: sanitizeRichText(current.answerText) }} />
                  {audioUrl && <audio controls src={audioUrl} onClick={(event) => event.stopPropagation()} />}
                </span>
              </span>
            )}
          </button>
          <p className="counter">{doneCount + 1} / {doneCount + queue.length}</p>
          <div className="answer-row">
            <button className="hard-button" onClick={() => answer(false, true)}><X />{t('hard')}</button>
            <button className="remember-button" onClick={() => answer(true, true)}><Check />{t('remember')}</button>
          </div>
        </>
      )}
    </section>
  );
};

const LibraryView = ({ t, refresh }: { t: (key: TranslationKey) => string; refresh: () => void }) => {
  const [preview, setPreview] = useState<ImportPreview>();
  const [mode, setMode] = useState<ImportMode>('copy');
  const [message, setMessage] = useState('');

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const nextPreview = await parseImportFile(file);
      setPreview(nextPreview);
      setMode(nextPreview.existingDeckId ? 'copy' : 'copy');
      setMessage('');
    } catch (error) {
      setPreview(undefined);
      setMessage(error instanceof Error ? error.message : 'Import failed');
    }
  };

  const submit = async () => {
    if (!preview) return;
    try {
      await applyImport(preview, preview.kind === 'backup' ? 'replace' : mode);
      setMessage(t('importReady'));
      setPreview(undefined);
      refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Import failed');
    }
  };

  return (
    <section className="screen">
      <header className="topbar large">
        <h1>{t('library')}</h1>
        <FileUp className="muted-icon" />
      </header>
      <div className="settings-panel">
        <h2>{t('importJson')}</h2>
        <FilePicker label={t('import')} accept="application/json,.json" icon={Upload} onChange={() => undefined} onRawChange={onFile} />
        {preview && (
          <div className="import-preview">
            <strong>{preview.title}</strong>
            <span>{preview.cardCount} {t('cardsCount')} · {preview.mediaCount} media</span>
            {preview.issues.length ? <p className="error">{t('importIssues')}: {preview.issues.join(' ')}</p> : <p>{t('importReady')}</p>}
            {preview.kind === 'deck' && (
              <label>{t('importMode')}
                <select value={mode} onChange={(event) => setMode(event.target.value as ImportMode)}>
                  <option value="copy">{t('copy')}</option>
                  <option value="replace" disabled={!preview.existingDeckId}>{t('replace')}</option>
                  <option value="merge" disabled={!preview.existingDeckId || !preview.canMerge}>{t('merge')}</option>
                </select>
              </label>
            )}
            <button className="primary-button" disabled={preview.issues.length > 0} onClick={submit}>{t('applyImport')}</button>
          </div>
        )}
        {message && <p className="note">{message}</p>}
      </div>
    </section>
  );
};

const MoreView = ({
  t,
  settings,
  updateSettings,
  refresh,
}: {
  t: (key: TranslationKey) => string;
  settings: AppSettings;
  updateSettings: (settings: AppSettings) => Promise<void>;
  refresh: () => void;
}) => {
  const [message, setMessage] = useState('');
  const [syncSettings, setSyncSettings] = useState<SyncSettings>({
    token: '',
    owner: 'RAzDva1',
    repo: 'memorizer-sync',
    branch: 'main',
    path: 'memorizer-sync.json',
  });

  useEffect(() => {
    db.getSyncSettings().then(setSyncSettings);
  }, []);

  const updateSyncSetting = (key: keyof SyncSettings, value: string) => {
    setSyncSettings((current) => ({ ...current, [key]: value }));
  };

  const exportBackup = async () => {
    const backup = await createBackup();
    downloadJson(backup, `memorizer-backup-${new Date().toISOString().slice(0, 10)}.json`);
  };

  const clear = async () => {
    if (!confirm(t('clearAll'))) return;
    await db.clearAll();
    refresh();
  };

  const optimizeMedia = async () => {
    setMessage(t('optimizingMedia'));
    const media = await db.getMedia();
    let changed = 0;
    let savedBytes = 0;

    for (const asset of media) {
      const result = await optimizeImageAsset(asset);
      if (!result.changed) continue;
      changed += 1;
      savedBytes += result.savedBytes;
      await db.saveMedia(result.asset);
    }

    refresh();
    setMessage(`${t('optimizeDone')}: ${changed} / ${formatBytes(savedBytes)}`);
  };

  const saveSyncSettings = async () => {
    await db.saveSyncSettings(syncSettings);
    setMessage(t('syncSaved'));
  };

  const clearToken = async () => {
    const next = { ...syncSettings, token: '' };
    setSyncSettings(next);
    await db.saveSyncSettings(next);
    setMessage(t('syncSaved'));
  };

  const pushSync = async () => {
    try {
      if (!confirm(t('pushSyncConfirm'))) return;
      await db.saveSyncSettings(syncSettings);
      const cards = await db.getCards();
      if (cards.length === 0) {
        setMessage(t('emptyPushBlocked'));
        return;
      }
      setMessage(t('pushingSync'));
      const result = await pushSyncBundle(syncSettings);
      setMessage(`${t('syncDone')}: ${result.decks} ${t('decks')} · ${result.cards} ${t('cardsCount')}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Sync failed');
    }
  };

  const pullSync = async () => {
    try {
      if (!confirm(t('pullSyncConfirm'))) return;
      await db.saveSyncSettings(syncSettings);
      setMessage(t('pullingSync'));
      const result = await pullSyncBundle(syncSettings);
      refresh();
      setMessage(`${t('syncDone')}: ${result.decks} ${t('decks')} · ${result.cards} ${t('cardsCount')}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Sync failed');
    }
  };

  return (
    <section className="screen">
      <header className="topbar large">
        <h1>{t('more')}</h1>
        <Settings className="muted-icon" />
      </header>
      <div className="settings-panel">
        <h2>{t('settings')}</h2>
        <label>{t('locale')}
          <select value={settings.locale} onChange={(event) => updateSettings({ locale: event.target.value as Locale })}>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
      <div className="settings-panel">
        <h2>{t('backup')}</h2>
        <div className="button-cluster">
          <button className="secondary-button" onClick={exportBackup}><Download />{t('export')}</button>
          <button className="secondary-button" onClick={optimizeMedia}><Image />{t('optimizeMedia')}</button>
          <button className="danger-button" onClick={clear}><Trash2 />{t('clearAll')}</button>
        </div>
      </div>
      <div className="settings-panel">
        <h2>{t('sync')}</h2>
        <div className="sync-grid">
          <label>{t('githubOwner')}
            <input value={syncSettings.owner} onChange={(event) => updateSyncSetting('owner', event.target.value.trim())} />
          </label>
          <label>{t('githubRepo')}
            <input value={syncSettings.repo} onChange={(event) => updateSyncSetting('repo', event.target.value.trim())} />
          </label>
          <label>{t('githubBranch')}
            <input value={syncSettings.branch} onChange={(event) => updateSyncSetting('branch', event.target.value.trim())} />
          </label>
          <label>{t('githubPath')}
            <input value={syncSettings.path} onChange={(event) => updateSyncSetting('path', event.target.value.trim())} />
          </label>
        </div>
        <label>{t('githubToken')}
          <input
            type="password"
            value={syncSettings.token}
            autoComplete="off"
            onChange={(event) => updateSyncSetting('token', event.target.value.trim())}
          />
        </label>
        <div className="button-cluster sync-actions">
          <button className="secondary-button" onClick={saveSyncSettings}><Save />{t('saveSyncSettings')}</button>
          <button className="secondary-button" onClick={clearToken}><Trash2 />{t('clearToken')}</button>
          <button className="primary-button" onClick={pushSync}><UploadCloud />{t('pushSync')}</button>
          <button className="secondary-button" onClick={pullSync}><Download />{t('pullSync')}</button>
        </div>
      </div>
      {message && <p className="status-note">{message}</p>}
    </section>
  );
};

const FilePicker = ({
  label,
  accept,
  icon: Icon,
  onChange,
  onRawChange,
}: {
  label: string;
  accept: string;
  icon: typeof Image;
  onChange: (file: File | undefined) => void;
  onRawChange?: (event: ChangeEvent<HTMLInputElement>) => void;
}) => (
  <label className="file-picker">
    <Icon size={22} />
    <span>{label}</span>
    <input
      type="file"
      accept={accept}
      onChange={(event) => {
        onChange(event.target.files?.[0]);
        onRawChange?.(event);
      }}
    />
  </label>
);

const Toggle = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) => (
  <label className="toggle">
    <span>{label}</span>
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
  </label>
);

const RichTextEditor = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const safeValue = sanitizeRichText(value);
    if (element.innerHTML !== safeValue) {
      element.innerHTML = safeValue;
    }
  }, [value]);

  const sync = () => onChange(ref.current?.innerHTML ?? '');

  const paste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const html = event.clipboardData.getData('text/html');
    const text = event.clipboardData.getData('text/plain');
    if (!html && !text) return;

    event.preventDefault();
    event.stopPropagation();

    const nextHtml = html ? sanitizeRichText(html) : plainTextToRichText(text);
    document.execCommand('insertHTML', false, nextHtml);
    sync();
  };

  return (
    <label>
      {label}
      <div
        ref={ref}
        className="rich-editor"
        contentEditable
        role="textbox"
        aria-multiline="true"
        data-placeholder={label}
        onInput={sync}
        onBlur={() => onChange(sanitizeRichText(ref.current?.innerHTML ?? ''))}
        onPaste={paste}
      />
    </label>
  );
};

const ProgressBar = ({ stats }: { stats?: DeckStats }) => {
  const total = stats?.total ?? 0;
  const learned = stats?.learned ?? 0;
  const percent = total ? Math.round((learned / total) * 100) : 0;

  return (
    <div className="progress-wrap" aria-label={`${percent}%`}>
      <span className="progress-track">
        <span className="progress-fill" style={{ width: `${percent}%` }} />
      </span>
      <span>{percent}%</span>
    </div>
  );
};

const EmptyState = ({
  label,
  icon: Icon,
  action,
}: {
  label: string;
  icon: typeof Layers;
  action?: ReactNode;
}) => (
  <div className="empty-state">
    <Icon size={42} />
    <p>{label}</p>
    {action}
  </div>
);

import { SrsState } from './types';

const DAY = 24 * 60 * 60 * 1000;

export const createInitialSrs = (): SrsState => ({
  dueAt: new Date().toISOString(),
  intervalDays: 0,
  ease: 2.2,
  reviewCount: 0,
});

export const isDue = (srs: SrsState, at = new Date()): boolean => new Date(srs.dueAt).getTime() <= at.getTime();

export const reviewCard = (srs: SrsState, remembered: boolean, at = new Date()): SrsState => {
  if (!remembered) {
    return {
      ...srs,
      dueAt: at.toISOString(),
      intervalDays: 0,
      ease: Math.max(1.3, srs.ease - 0.2),
      lastReviewedAt: at.toISOString(),
    };
  }

  const nextInterval =
    srs.reviewCount === 0 ? 1 : srs.intervalDays <= 1 ? 3 : Math.max(1, Math.round(srs.intervalDays * srs.ease));

  return {
    dueAt: new Date(at.getTime() + nextInterval * DAY).toISOString(),
    intervalDays: nextInterval,
    ease: Math.min(3, srs.ease + 0.08),
    reviewCount: srs.reviewCount + 1,
    lastReviewedAt: at.toISOString(),
  };
};

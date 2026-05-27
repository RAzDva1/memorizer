import { MediaAsset, MediaType } from './types';
import { uid } from './db';

const IMAGE_MAX_DIMENSION = 960;
const IMAGE_QUALITY = 0.68;

const shouldSkipImageCompression = (blob: Blob) =>
  blob.type === 'image/gif' || blob.type === 'image/svg+xml' || !blob.type.startsWith('image/');

const loadImage = (blob: Blob): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new window.Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image could not be loaded.'));
    };
    image.src = url;
  });

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image could not be compressed.'))), type, quality);
  });

export const optimizeImageBlob = async (blob: Blob): Promise<{ blob: Blob; mimeType: string; changed: boolean }> => {
  if (shouldSkipImageCompression(blob)) {
    return { blob, mimeType: blob.type || 'application/octet-stream', changed: false };
  }

  const image = await loadImage(blob);
  const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    return { blob, mimeType: blob.type || 'application/octet-stream', changed: false };
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const optimized = await canvasToBlob(canvas, 'image/jpeg', IMAGE_QUALITY);
  if (optimized.size >= blob.size) {
    return { blob, mimeType: blob.type || 'application/octet-stream', changed: false };
  }

  return { blob: optimized, mimeType: 'image/jpeg', changed: true };
};

export const fileToAsset = async (file: File, type: MediaType): Promise<MediaAsset> => {
  const optimized = type === 'image' ? await optimizeImageBlob(file) : undefined;

  return {
    id: uid(type),
    type,
    mimeType: optimized?.mimeType ?? file.type ?? (type === 'image' ? 'image/*' : 'audio/*'),
    blob: optimized?.blob ?? file,
    createdAt: new Date().toISOString(),
  };
};

export const optimizeImageAsset = async (asset: MediaAsset): Promise<{ asset: MediaAsset; changed: boolean; savedBytes: number }> => {
  if (asset.type !== 'image') {
    return { asset, changed: false, savedBytes: 0 };
  }

  const optimized = await optimizeImageBlob(asset.blob);
  if (!optimized.changed) {
    return { asset, changed: false, savedBytes: 0 };
  }

  return {
    asset: {
      ...asset,
      mimeType: optimized.mimeType,
      blob: optimized.blob,
    },
    changed: true,
    savedBytes: Math.max(0, asset.blob.size - optimized.blob.size),
  };
};

export const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export const dataUrlToBlob = async (dataUrl: string): Promise<{ blob: Blob; mimeType: string }> => {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const mimeType = dataUrl.match(/^data:([^;]+)/)?.[1] ?? blob.type;
  return { blob, mimeType };
};

export const urlToBlob = async (url: string): Promise<{ blob: Blob; mimeType: string }> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load media: ${url}`);
  const blob = await response.blob();
  return { blob, mimeType: blob.type || response.headers.get('content-type') || 'application/octet-stream' };
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

export const sanitizeRichText = (input: string): string => {
  if (!input.trim()) return '';

  const doc = new DOMParser().parseFromString(input, 'text/html');

  const serialize = (node: ChildNode): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeHtml(node.textContent ?? '');
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();
    const children = Array.from(element.childNodes).map(serialize).join('');

    if (tag === 'strong' || tag === 'b') return children ? `<strong>${children}</strong>` : '';
    if (tag === 'em' || tag === 'i') return children ? `<em>${children}</em>` : '';
    if (tag === 'br') return '<br>';
    if (tag === 'p' || tag === 'div' || tag === 'li') return children ? `${children}<br>` : '';

    return children;
  };

  return Array.from(doc.body.childNodes)
    .map(serialize)
    .join('')
    .replace(/(<br>\s*){3,}/g, '<br><br>')
    .replace(/(<br>\s*)+$/g, '')
    .trim();
};

export const plainTextToRichText = (value: string): string => sanitizeRichText(escapeHtml(value).replace(/\n/g, '<br>'));

export const stripRichText = (value: string): string => {
  const doc = new DOMParser().parseFromString(sanitizeRichText(value), 'text/html');
  return doc.body.textContent?.replace(/\s+/g, ' ').trim() ?? '';
};

export const hasRichTextContent = (value: string): boolean => stripRichText(value).length > 0;

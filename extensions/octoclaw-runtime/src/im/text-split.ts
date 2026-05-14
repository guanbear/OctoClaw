export interface SplitTextOptions {
  markers?: boolean;
}

function takeTextChunk(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const paragraphBreak = text.lastIndexOf("\n\n", maxLength - 1);
  if (paragraphBreak > 0) {
    return text.slice(0, paragraphBreak + 2);
  }

  const lineBreak = text.lastIndexOf("\n", maxLength - 1);
  if (lineBreak > 0) {
    return text.slice(0, lineBreak + 1);
  }

  return text.slice(0, maxLength);
}

function splitWithoutMarkers(text: string, maxLength: number, markerTotal?: number): string[] {
  const source = String(text ?? "");
  if (!source) return [];
  if (maxLength <= 0) {
    throw new Error("maxLength must be greater than 0");
  }

  const chunks: string[] = [];
  let remaining = source;
  while (remaining) {
    const marker = markerTotal && markerTotal > 1
      ? `\n\n(${chunks.length + 1}/${markerTotal})`
      : "";
    const payloadLimit = maxLength - marker.length;
    if (payloadLimit <= 0) {
      throw new Error("maxLength is too small for segment markers");
    }
    const chunk = takeTextChunk(remaining, payloadLimit);
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }

  return chunks;
}

export function splitIMText(text: string, maxLength: number, options: SplitTextOptions = {}): string[] {
  const baseChunks = splitWithoutMarkers(text, maxLength);
  if (!options.markers || baseChunks.length <= 1) return baseChunks;

  let total = baseChunks.length;
  for (let attempt = 0; attempt < 8; attempt++) {
    const chunks = splitWithoutMarkers(text, maxLength, total);
    if (chunks.length === total) {
      return chunks.map((chunk, index) => `${chunk}\n\n(${index + 1}/${total})`);
    }
    total = chunks.length;
  }

  const chunks = splitWithoutMarkers(text, maxLength, total);
  return chunks.map((chunk, index) => `${chunk}\n\n(${index + 1}/${chunks.length})`);
}

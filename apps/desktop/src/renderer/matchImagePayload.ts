import type { MatchRecord, MatchUpdateInput, MatchUploadInput } from '../shared/contracts';

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  return btoa(parts.join(''));
}

export function confirmedImagePayload(image: MatchUploadInput, input: MatchUpdateInput, record: MatchRecord) {
  const { data, ...metadata } = image;
  return { ...metadata, data_base64: bytesToBase64(data), input, recognition: record.ocr_status === 'completed'
    ? { outcome: record.outcome, players: record.players, raw_text: record.raw_text, warnings: record.warnings } : null };
}

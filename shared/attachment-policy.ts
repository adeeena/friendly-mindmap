export const BASIC_ATTACHMENT_BYTES = 5_242_880;
export const BASIC_ATTACHMENT_COUNT = 1;

export type AttachmentRole = 'guest' | 'basic' | 'admin';

export function attachmentPolicyViolation(
  role: AttachmentRole, sizes: readonly number[],
): 'size' | 'count' | null {
  if (role === 'admin') return null;
  if (sizes.some((size) => size > BASIC_ATTACHMENT_BYTES)) return 'size';
  return sizes.length > BASIC_ATTACHMENT_COUNT ? 'count' : null;
}

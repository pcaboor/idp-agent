/**
 * A forge handle — `@user` or `@org/team`. **Not** an entity owner reference
 * (`group:default/tiger`): CODEOWNERS wants the first, an entity wants the
 * second, and one flag cannot be both. Translating between them would be
 * inference, and the namespace does not survive the round trip.
 */
const FORGE_HANDLE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9._-]+)?$/

export function isForgeHandle(raw: string): boolean {
  return FORGE_HANDLE.test(raw)
}

export function renderCodeowners(handle: string): string {
  return `# Every path needs an owner. A CODEOWNERS made only of comments requires
# no reviewer at all, which silently removes the review this whole model
# rests on — the merge is the act of authorisation.
*  ${handle}
`
}

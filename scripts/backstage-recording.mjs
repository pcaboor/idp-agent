/**
 * What `pnpm demo:backstage:docker --record` decides about a page the demo
 * Backstage served, before it writes it to tests/contract/backstage/: whether
 * it is the recording already there, and whether an organisation page holds
 * what the read did not ask for. Read by `tests/unit/demo-backstage.test.ts`.
 */

/**
 * A recorded page as it is compared with the next one: without the uid and the
 * etag each run draws, its items in ref order, since Backstage orders a page by
 * uid. Two pages that differ in nothing else are the same recording.
 *
 * @param {{ items?: unknown[] }} page
 * @returns {string}
 */
export function comparable(page) {
  const items = (page.items ?? []).map((item) => {
    const { uid: _uid, etag: _etag, ...metadata } = item?.metadata ?? {}
    return { ...item, metadata }
  })
  const ref = (item) => `${item.kind}:${item.metadata.namespace ?? 'default'}/${item.metadata.name}`
  items.sort((left, right) => (ref(left) < ref(right) ? -1 : ref(left) > ref(right) ? 1 : 0))
  return JSON.stringify({ ...page, items })
}

/**
 * The items of an organisation page that carry a profile or annotations: the
 * read asks for neither, so a page holding one proves the catalogue did not
 * honour `fields`, and is not written.
 *
 * @template Item
 * @param {{ items?: Item[] }} page
 * @returns {Item[]}
 */
export function overserved(page) {
  return (page.items ?? []).filter((item) => item?.spec?.profile !== undefined || item?.metadata?.annotations !== undefined)
}

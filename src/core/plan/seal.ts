/**
 * A Map that refuses to change.
 *
 * `Object.freeze` does nothing to a Map: `set` lives on the prototype and
 * writes internal slots, so a frozen Map is still a writable Map. Shadowing the
 * mutators on the instance answered the cast that ignores `ReadonlyMap`, and
 * not every one of those: `Map.prototype.set.call(map, key, value)` reached the
 * slots past the shadow (measured). So this is not a Map at all. The entries
 * live in a private field of an object Map's own methods refuse as a receiver
 * — `Map.prototype.set.call(sealed, …)` is a `TypeError` — and the mutators it
 * does carry say why they refuse.
 *
 * Shared because two values need it: the paths a signature computed, and the
 * bytes a clearance vouches the base still holds. Either one, moved after the
 * fact, is a value no gate judged. `paths` is the field §5.2 is about — the
 * engine chooses where bytes go, and a model cannot aim at a path — and
 * `expected.files` is what a forge proves the base against, while `isCleared`
 * checks the clearance's identity and never its contents. A map a caller could
 * still write would leave the strongest guarantee in the design as the one
 * value a mutation could move.
 *
 * What this does NOT cover: a copy. `new Map(sealed)` is a writable Map of the
 * same entries, and a caller may do what it likes with its own; what it cannot
 * do is change the one it was handed.
 */
class Sealed<K, V> implements ReadonlyMap<K, V> {
  readonly #entries: Map<K, V>
  readonly #message: string

  constructor(entries: ReadonlyMap<K, V>, message: string) {
    this.#entries = new Map(entries)
    this.#message = message
  }

  get size(): number {
    return this.#entries.size
  }

  get(key: K): V | undefined {
    return this.#entries.get(key)
  }

  has(key: K): boolean {
    return this.#entries.has(key)
  }

  forEach(each: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#entries.forEach((value, key) => {
      each.call(thisArg, value, key, this)
    })
  }

  entries(): MapIterator<[K, V]> {
    return this.#entries.entries()
  }

  keys(): MapIterator<K> {
    return this.#entries.keys()
  }

  values(): MapIterator<V> {
    return this.#entries.values()
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#entries.entries()
  }

  /** What a cast to `Map` finds, and is told. */
  set(): never {
    throw new TypeError(this.#message)
  }

  delete(): never {
    throw new TypeError(this.#message)
  }

  clear(): never {
    throw new TypeError(this.#message)
  }
}

// The methods above are the only way to the entries; none of them may be
// swapped for one that hands the field out.
Object.freeze(Sealed.prototype)

export const sealed = <K, V>(entries: ReadonlyMap<K, V>, message: string): ReadonlyMap<K, V> =>
  Object.freeze(new Sealed(entries, message))

import { describe, expect, it } from 'vitest'
import {
  COMMENTARY_LIMITS,
  checkCommentary,
  type CommentaryFacts,
  type KnownEntity,
} from '../../src/core/answer/commentary.js'
import { inertLine } from '../../src/cli/render/plain.js'

/**
 * The engine's check on the model's own sentences (ADR-0008). A pure function
 * of plain data: the model's text, every entity the graph holds, the references
 * the tools returned, the vocabulary the model was shown and the question.
 */

const entity = (ref: string, declares: string[] = []): KnownEntity => ({
  ref,
  name: ref.slice(ref.indexOf('/') + 1),
  declares,
})

const BILLING_DB = 'resource:default/billing-db-prod'
const ORDERS_DB = 'resource:default/orders-db-prod'
const BILLING_API = 'component:default/billing-api'

const ENTITIES: KnownEntity[] = [
  entity(BILLING_DB, ['group:default/tiger', 'database', 'prod']),
  entity(ORDERS_DB, ['group:default/lion', 'database', 'prod']),
  entity(BILLING_API, ['group:default/tiger', 'service', 'production', 'payments-team']),
  // A name that is also a plain word.
  entity('component:default/website', ['group:default/lion', 'website', 'production']),
  // A name of one word, which only its exact spelling protects.
  entity('resource:default/ledger', ['group:default/lion', 'database', 'prod']),
]

const facts = (overrides: Partial<CommentaryFacts> = {}): CommentaryFacts => ({
  entities: ENTITIES,
  witnessed: new Set([BILLING_DB]),
  vocabulary: [],
  question: 'which databases are in prod?',
  clean: (text) => inertLine(text, Number.POSITIVE_INFINITY),
  ...overrides,
})

/** The conclusion the check keeps for one text, one sentence per element. */
const kept = (conclusion: string, overrides: Partial<CommentaryFacts> = {}): readonly string[] =>
  checkCommentary({ conclusion }, facts(overrides)).conclusion

/** Every name the check reported, whatever the sentence. */
const named = (conclusion: string, overrides: Partial<CommentaryFacts> = {}): string[] =>
  checkCommentary({ conclusion }, facts(overrides)).dropped.flatMap((drop) =>
    drop.why === 'unread' ? [...drop.names] : [],
  )

describe('checkCommentary keeps what names only what was read', () => {
  it('keeps an English sentence about a witnessed entity, as the model wrote it', () => {
    expect(kept('billing-db-prod is owned by group:default/tiger.')).toEqual([
      'billing-db-prod is owned by group:default/tiger.',
    ])
  })

  it('keeps a sentence that names nothing at all', () => {
    const result = checkCommentary(
      { intro: 'Here is the one production database I found.' },
      facts(),
    )
    expect(result.intro).toBe('Here is the one production database I found.')
    expect(result.dropped).toEqual([])
  })

  it('keeps a witnessed entity whatever its case, by its full and short references', () => {
    expect(
      kept(
        'Billing-DB-Prod holds invoices. Its reference is resource:default/billing-db-prod. ' +
          'Its short one is resource:billing-db-prod.',
      ),
    ).toHaveLength(3)
  })

  it('keeps a value the witnessed entity declares, its owner in full and short', () => {
    expect(kept('It belongs to group:default/tiger, that is tiger.')).toHaveLength(1)
    expect(kept('It belongs to default/tiger.')).toHaveLength(1)
  })

  it('keeps an identifier the question itself holds', () => {
    // A question about payments-db may be answered "payments-db is not declared".
    const question = 'is payments-db declared?'
    expect(kept('payments-db is not declared in this catalogue.', { question })).toEqual([
      'payments-db is not declared in this catalogue.',
    ])
  })

  it('keeps an identifier the vocabulary the model was shown holds', () => {
    // The Analyst's opening message lists the kinds, types, environments and
    // owners in use: the model read them there.
    expect(
      kept('No billing-access grant reaches it.', {
        vocabulary: ['billing-access'],
      }),
    ).toHaveLength(1)
    expect(kept('No billing-access grant reaches it.')).toEqual([])
  })

  it('keeps numbers, dates, times and abbreviations, which name no entity', () => {
    expect(
      kept('It was declared on 2026-09-25 at 10:30, e.g. for 3.5 times the load.'),
    ).toHaveLength(1)
  })
})

describe('checkCommentary drops what names anything else', () => {
  it('drops a sentence naming an entity the graph holds and no tool returned', () => {
    const result = checkCommentary(
      { conclusion: 'It is billing-db-prod. The other is orders-db-prod.' },
      facts(),
    )
    expect(result.conclusion).toEqual(['It is billing-db-prod.'])
    expect(result.dropped).toEqual([
      {
        why: 'unread',
        sentence: 'The other is orders-db-prod.',
        names: ['orders-db-prod'],
      },
    ])
  })

  it('drops it whole, never edited', () => {
    const result = checkCommentary(
      { conclusion: 'billing-db-prod and orders-db-prod are both in prod.' },
      facts(),
    )
    expect(result.conclusion).toEqual([])
    expect(JSON.stringify(result.conclusion)).not.toContain('billing')
  })

  it('drops an invented identifier-shaped token, of any joiner', () => {
    for (const token of ['ghost-db', 'orders_db', 'component:default/x', 'group:default/panther']) {
      expect(named(`The answer is ${token}.`)).toEqual([token])
    }
  })

  it("drops an unwitnessed entity's full and short references", () => {
    for (const form of [ORDERS_DB, 'resource:orders-db-prod', 'default/orders-db-prod']) {
      expect(named(`See ${form} as well.`)).toEqual([form])
    }
  })

  it('finds a name whatever the punctuation beside it', () => {
    for (const sentence of [
      'It is not (orders-db-prod).',
      'It is not «orders-db-prod».',
      'It is not orders-db-prod’s twin.',
      "It is not orders-db-prod's twin.",
      'It is not "orders-db-prod".',
      'It is not orders-db-prod.',
      'It is not orders-db-prod…',
      'It is not orders-db-prod, nor anything.',
    ]) {
      expect(named(sentence), sentence).toEqual(['orders-db-prod'])
    }
  })

  it('reads the same punctuation around a witnessed name as a boundary, and keeps it', () => {
    for (const sentence of [
      'It is (billing-db-prod).',
      'It is «billing-db-prod».',
      'It is billing-db-prod’s owner that matters.',
      'It is billing-db-prod.',
    ]) {
      expect(kept(sentence), sentence).toEqual([sentence])
    }
  })

  it('finds a name any case spells', () => {
    expect(named('ORDERS-DB-PROD is not it.')).toEqual(['orders-db-prod'])
  })

  it('finds a name split by a zero-width character, a soft hyphen or a bidi control', () => {
    for (const hidden of [
      'orders\u200B-db-prod',
      'orders-\u200Ddb-prod',
      'orders\u00AD-db-prod',
      'orders-db\u2060-prod',
    ]) {
      expect(named(`It reads ${hidden} too.`), JSON.stringify(hidden)).toEqual(['orders-db-prod'])
    }
    // A bidi control is spelled out by the cleaner, so the name no longer
    // reads as one — and what is left is an identifier no tool returned.
    expect(kept('It reads orders-db\u202E-prod too.')).toEqual([])
    expect(kept('It reads billing-db\u202E-prod too.')).toEqual([])
  })

  it('finds a name written in full-width letters or with a hyphen lookalike', () => {
    expect(named('ｏｒｄｅｒｓ－ｄｂ－ｐｒｏｄ is not it.')).toEqual(['orders-db-prod'])
    expect(named('orders\u2010db\u2010prod is not it.')).toEqual(['orders-db-prod'])
    expect(named('orders\u2011db\u2212prod is not it.')).toEqual(['orders-db-prod'])
  })

  it('finds a name the model hid inside a longer identifier the question holds', () => {
    const question = 'where is orders-db-prod.yml?'
    expect(named('orders-db-prod.yml is under databases.', { question })).toEqual([
      'orders-db-prod',
    ])
  })

  it('finds a name written after a terminal sequence, as the reader would see it', () => {
    // The check reads the text the cleaner prints: a CSI inside a name is
    // gone from the screen, and so is it from what is matched.
    expect(named('It reads orders\u001B[0m-db-prod too.')).toEqual(['orders-db-prod'])
  })
})

describe('checkCommentary reads a name as the reader sees it', () => {
  it('finds a one-word name carrying a character that prints as nothing', () => {
    // Default-ignorable, not all format characters: a variation selector, the
    // combining grapheme joiner, a Mongolian selector, a Khmer inherent vowel,
    // a tag character. Each is a mark or a letter to a regular expression, so
    // it would sit inside the word and spell another one.
    for (const hidden of [
      'ledger\uFE0F',
      'led\u034Fger',
      'led\u180Bger',
      'led\u17B4ger',
      'led\u{E0100}ger',
      'led\u{E0041}ger',
    ]) {
      expect(named(`It is not used by ${hidden}.`), JSON.stringify(hidden)).toEqual(['ledger'])
      expect(
        checkCommentary({ intro: `It is not used by ${hidden}.` }, facts()).intro,
        JSON.stringify(hidden),
      ).toBeUndefined()
    }
    expect(named('It reads orders\u034F-db-prod too.')).toEqual(['orders-db-prod'])
  })

  it('finds a name whose parts a dash, a minus or a line joins', () => {
    // A terminal draws each of them one cell wide, where they read as `-`.
    for (const dash of [
      '\u2013', // en dash
      '\u2014', // em dash
      '\u2015', // horizontal bar
      '\u058A', // Armenian hyphen
      '\u05BE', // Hebrew maqaf
      '\u02D7', // modifier letter minus
      '\u2796', // heavy minus
      '\u2500', // box drawings light horizontal
      '\u2501', // box drawings heavy horizontal
      '\u23AF', // horizontal line extension
      '\uFE58', // small em dash
      '\u2E3A', // two-em dash
      '\u30FC', // prolonged sound mark, between two Latin letters
      '\uFF70', // its half-width form
      '\u4E00', // the ideograph for one, which is a line
      '\u3161', // the Hangul vowel eu, which is a line
    ]) {
      const hidden = `orders${dash}db${dash}prod`
      expect(named(`It reads ${hidden} too.`), JSON.stringify(dash)).toEqual(['orders-db-prod'])
    }
  })

  it('prints no soft hyphen, so what is checked is what is read', () => {
    // Some terminals show U+00AD as `-`, others as nothing: the one reading
    // that stays is the one where it is gone.
    expect(kept('It reads orders\u00ADdb\u00ADprod too.')).toEqual(['It reads ordersdbprod too.'])
    expect(named('It reads orders\u00AD-db-prod too.')).toEqual(['orders-db-prod'])
  })

  it('keeps prose that closes its dashes, and the prolonged sound mark in a word', () => {
    // A dash is read as a joiner to find a name the graph holds, never to make
    // an identifier of two words: "the database—the one in prod—" is prose.
    expect(kept('The database\u2014the one in prod\u2014is owned by tiger.')).toHaveLength(1)
    expect(kept('It serves the Paris\u2013Lyon line.')).toHaveLength(1)
    expect(kept('データベースは本番環境にあります。')).toHaveLength(1)
    expect(kept('billing-db-prod\u2014the one read\u2014belongs to tiger.')).toHaveLength(1)
    // The price, documented in ADR-0008: an invented identifier written with a
    // dash is two plain words to the check, and passes.
    expect(kept('It is not ghost\u2013db.')).toHaveLength(1)
  })

  it('drops an identifier whose letters a lookalike of another script replaces', () => {
    // A Cyrillic `ԁ` and a Greek `ο` beside each hyphen: cutting the word
    // where the script changes would leave three plain words and no name.
    for (const lookalike of ['billing-\u0501b-\u0501ev', 'c\u03BFmpliance-db-dev']) {
      expect(kept(`Unlike ${lookalike}, both are here.`), lookalike).toEqual([])
      expect(named(`Unlike ${lookalike}, both are here.`), lookalike).toHaveLength(1)
    }
    expect(kept('Unlike billing\u2013\u0501b\u2013\u0501ev, both are here.')).toEqual([])
  })

  it('drops a word that mixes the letters of two scripts written with spaces', () => {
    // `l` `е` `dger`, a Cyrillic `е`: no name the graph holds, printed as one.
    expect(named('It is not used by l\u0435dger.')).toEqual(['l\u0435dger'])
    // A word of one script is a word, whatever the script.
    expect(kept('Это база данных PostgreSQL.')).toHaveLength(1)
    // The price, documented in ADR-0008: a micro sign is a Greek letter.
    expect(kept('It answers in 5\u00B5s.')).toEqual([])
  })

  it('still cuts where a script written without spaces meets a name', () => {
    // Korean glues its particles to the word before them, Japanese and Thai
    // write no space at all.
    expect(kept('billing-db-prod는 운영 환경에 있습니다.')).toHaveLength(1)
    expect(named('orders-db-prod는 읽지 않았습니다.')).toEqual(['orders-db-prod'])
    expect(kept('billing-db-prodอยู่ในระบบจริง')).toHaveLength(1)
  })
})

describe('checkCommentary on a plain word that is also an entity name', () => {
  // Documented behaviour: a word that equals the name of an entity no tool
  // returned is read as naming it, and the sentence is dropped. The safe
  // direction — a missing sentence, never a wrong one. A word the witnessed
  // entities or the vocabulary declare is read as that value instead.
  it('drops a sentence whose plain word is the name of an unwitnessed entity', () => {
    expect(named('The website is not in this answer.')).toEqual(['website'])
  })

  it('keeps it when a witnessed entity declares that word as a value', () => {
    const entities = [...ENTITIES, entity('component:default/artist-web', ['website'])]
    expect(
      kept('artist-web is a website.', {
        entities,
        witnessed: new Set(['component:default/artist-web']),
      }),
    ).toEqual(['artist-web is a website.'])
  })

  it('keeps it when the vocabulary the model was shown holds it', () => {
    expect(kept('No website is among them.', { vocabulary: ['website'] })).toHaveLength(1)
  })
})

describe('checkCommentary, in every script', () => {
  it('French', () => {
    const result = checkCommentary(
      {
        conclusion:
          "La base billing-db-prod appartient à l'équipe tiger. " +
          'Elle ressemble à orders-db-prod, que je n’ai pas lue.',
      },
      facts({ question: 'quelles bases sont en prod ?' }),
    )
    expect(result.conclusion).toEqual(["La base billing-db-prod appartient à l'équipe tiger."])
    expect(named('Elle ressemble à «\u00A0orders-db-prod\u00A0».')).toEqual(['orders-db-prod'])
  })

  it('Japanese, with no space between the name and the next word', () => {
    const result = checkCommentary(
      {
        conclusion: 'billing-db-prodは本番環境にあります。orders-db-prodは読んでいません。',
      },
      facts({ question: '本番のデータベースは？' }),
    )
    expect(result.conclusion).toEqual(['billing-db-prodは本番環境にあります。'])
    expect(result.dropped).toMatchObject([{ why: 'unread', names: ['orders-db-prod'] }])
  })

  it('Japanese, an invented identifier beside kana', () => {
    expect(named('ghost-dbが見つかりました。')).toEqual(['ghost-db'])
  })

  it('Arabic', () => {
    const result = checkCommentary(
      {
        conclusion:
          'قاعدة البيانات billing-db-prod مملوكة لفريق tiger. ' + 'أما ghost-db فهي غير موجودة؟',
      },
      facts({ question: 'ما هي قواعد البيانات في الإنتاج؟' }),
    )
    expect(result.conclusion).toEqual(['قاعدة البيانات billing-db-prod مملوكة لفريق tiger.'])
    expect(result.dropped).toMatchObject([{ why: 'unread', names: ['ghost-db'] }])
  })

  it('an identifier of another script is an identifier too', () => {
    expect(named('Смотрите база_данных.')).toEqual(['база_данных'])
  })

  it('a word of another script joined by a hyphen is prose, as no catalogue name is spelled so', () => {
    expect(kept('Смотрите база-данных.')).toEqual(['Смотрите база-данных.'])
  })
})

describe('checkCommentary reads a hyphen between words as prose unless it spells a name', () => {
  // A hyphen joins the words of prose in more languages than it joins names:
  // dropping every sentence that holds one left a French conclusion empty.

  it.each([
    'Il faudra peut-être vérifier leurs droits.',
    "Autrement dit, c'est-à-dire les bases critiques, elles sont chez tiger.",
    'Ces bases sont au cœur du sous-système de facturation.',
    'Elles sont gérées par tiger, vis-à-vis de la facturation.',
    'Est-ce que d’autres environnements existent ?',
    'Both are read-only for their consumers.',
    'It is a well-known setup.',
  ])('keeps %s', (sentence) => {
    expect(kept(sentence)).toEqual([sentence])
  })

  it('drops a hyphenated word spelled like a name and sharing a part with one', () => {
    // `db` is a part of `billing-db-prod`: this reads as a name of this catalogue.
    expect(named('payments-db is where they live.')).toEqual(['payments-db'])
  })

  it('drops an identifier with a digit or another joiner, whatever its parts', () => {
    expect(named('Use ghost-v2 instead.')).toEqual(['ghost-v2'])
    expect(named('See ghost_gateway.')).toEqual(['ghost_gateway'])
  })

  it('keeps an invented name that shares no part with the catalogue: the label covers it', () => {
    expect(kept('Try ghost-gateway.')).toEqual(['Try ghost-gateway.'])
  })
})

describe('checkCommentary ends a sentence before a name, whatever its case', () => {
  // Unicode's rules read a full stop followed by a lower-case word as the same
  // sentence going on (`e.g. this`). Entity names are lower-case, so a sentence
  // that starts with one would be glued to the one before it, and a valid
  // sentence dropped with an invented name. The check ends a sentence there
  // too — after a word of two characters or more, before a word it reads as a
  // name — and nowhere else.
  it('keeps the sentence before one that starts with an unread name', () => {
    const result = checkCommentary(
      {
        conclusion: "Les deux appartiennent à l'équipe tiger. orders-db-dev n'est pas concernée.",
      },
      facts({
        entities: [...ENTITIES, entity('resource:default/orders-db-dev')],
        question: 'quelles bases de données sont en prod ?',
      }),
    )
    expect(result.conclusion).toEqual(["Les deux appartiennent à l'équipe tiger."])
    expect(result.dropped).toEqual([
      {
        why: 'unread',
        sentence: "orders-db-dev n'est pas concernée.",
        names: ['orders-db-dev'],
      },
    ])
  })

  it('ends it before an invented identifier and before a plain-word entity name', () => {
    expect(kept('It is in prod. ghost-db is not.')).toEqual(['It is in prod.'])
    expect(kept('It is in prod. ledger is not.')).toEqual(['It is in prod.'])
  })

  it('counts the two as two sentences toward the bounds', () => {
    const result = checkCommentary(
      { intro: 'Here is the database. billing-db-prod is the only one.' },
      facts(),
    )
    expect(result.intro).toBe('Here is the database.')
    expect(result.dropped).toEqual([{ why: 'bound', sentence: 'billing-db-prod is the only one.' }])
  })

  it('ends it after closing punctuation and before a name hiding a zero-width character', () => {
    expect(kept('It is owned by tiger.) orders​-db-prod is not.')).toEqual([
      'It is owned by tiger.)',
    ])
  })

  it('ends none after an abbreviation of single letters, nor before a plain word', () => {
    // `e.g.` is no sentence's end: the whole is one sentence, dropped whole.
    expect(named('Some are listed, e.g. orders-db-prod.')).toEqual(['orders-db-prod'])
    expect(kept('Some are listed, e.g. orders-db-prod.')).toEqual([])
    // An abbreviation before a word of prose, in any language, stays one sentence.
    expect(kept('Sie gehören tiger bzw. einem anderen Team.')).toEqual([
      'Sie gehören tiger bzw. einem anderen Team.',
    ])
    expect(kept('It holds invoices, receipts etc. and nothing else.')).toHaveLength(1)
  })
})

describe('checkCommentary bounds what it keeps', () => {
  it('keeps one sentence of introduction, the first it keeps', () => {
    const result = checkCommentary(
      {
        intro: 'First comes orders-db-prod. Here are the databases. And more.',
      },
      facts(),
    )
    expect(result.intro).toBe('Here are the databases.')
    expect(result.dropped.map((drop) => drop.why)).toEqual(['unread', 'bound'])
  })

  it('keeps at most three sentences of conclusion', () => {
    const result = checkCommentary({ conclusion: 'One. Two. Three. Four.' }, facts())
    expect(result.conclusion).toEqual(['One.', 'Two.', 'Three.'])
    expect(result.dropped).toEqual([{ why: 'bound', sentence: 'Four.' }])
  })

  it('drops an introduction longer than its bound rather than cutting it', () => {
    const long = `${'word '.repeat(COMMENTARY_LIMITS.introChars / 5)}end.`
    const result = checkCommentary({ intro: long }, facts())
    expect(result.intro).toBeUndefined()
    expect(result.dropped).toMatchObject([{ why: 'bound' }])
  })

  it('drops a conclusion sentence longer than the whole bound, and keeps the next', () => {
    const long = `${'word '.repeat(COMMENTARY_LIMITS.conclusionChars / 5)}end.`
    const result = checkCommentary({ conclusion: `${long} Short one.` }, facts())
    expect(result.conclusion).toEqual(['Short one.'])
  })

  it('stops at a sentence boundary once the conclusion would pass its bound', () => {
    const sentence = `X${'x'.repeat(199)}.`
    const result = checkCommentary({ conclusion: `${sentence} ${sentence} ${sentence}` }, facts())
    expect(result.conclusion).toEqual([sentence, sentence])
    expect(result.conclusion.join('').length).toBeLessThanOrEqual(COMMENTARY_LIMITS.conclusionChars)
  })

  it('cleans what it keeps to one line with nothing a terminal obeys', () => {
    const result = checkCommentary(
      { intro: 'Here\u001B[2J are the\u0007 \u202Edatabases.' },
      facts(),
    )
    expect(result.intro).toBe('Here are the \\u202edatabases.')
  })

  it('returns no commentary when nothing is left', () => {
    expect(checkCommentary({ intro: '  \n ', conclusion: '' }, facts())).toEqual({
      intro: undefined,
      conclusion: [],
      dropped: [],
    })
    expect(checkCommentary({}, facts()).intro).toBeUndefined()
  })
})

describe('checkCommentary, what it does not check', () => {
  // ADR-0008's narrow guarantee, pinned so it is not read as more: a name the
  // graph does not hold, written as plain words, is not a name to the check.
  // A team, a place, a product, a paraphrase of an unread entity and a figure
  // all pass; only the label tells the reader whose words they are.
  it('keeps an invented team, a figure and a paraphrase written in plain words', () => {
    expect(
      checkCommentary(
        {
          intro: 'This project is a platform of 12 services run by the Falcon team.',
          conclusion: 'It is read by billing api. It replicates to the Frankfurt cluster.',
        },
        facts({ witnessed: new Set() }),
      ),
    ).toEqual({
      intro: 'This project is a platform of 12 services run by the Falcon team.',
      conclusion: ['It is read by billing api.', 'It replicates to the Frankfurt cluster.'],
      dropped: [],
    })
  })
})

describe('checkCommentary on a name two entities share', () => {
  // Nothing tells `resource:default/billing-db` from `resource:other/billing-db`
  // in a sentence that says `billing-db`: once one is witnessed, the name is
  // read as that one, and only the other's reference still drops a sentence.
  const shared = [
    entity('resource:default/billing-db', ['group:default/tiger']),
    entity('resource:other/billing-db', ['group:default/lion']),
  ]
  const overrides = {
    entities: shared,
    witnessed: new Set(['resource:default/billing-db']),
    question: 'where is billing-db.yml?',
  }

  it('reads the shared name inside a longer identifier as the witnessed one', () => {
    expect(kept('billing-db.yml is under databases.', overrides)).toHaveLength(1)
  })

  it('still drops the reference of the unwitnessed one', () => {
    expect(named('See resource:other/billing-db too.', overrides)).toEqual([
      'resource:other/billing-db',
    ])
  })
})

describe('checkCommentary with nothing witnessed', () => {
  // An overview or a "nothing" is often answered straight away: every entity
  // the commentary names was then read by no tool, and is dropped.
  it('drops every entity named, and keeps the rest', () => {
    const result = checkCommentary(
      {
        intro: 'Here is the catalogue.',
        conclusion: 'billing-db-prod is the busiest.',
      },
      facts({ witnessed: new Set() }),
    )
    expect(result.intro).toBe('Here is the catalogue.')
    expect(result.conclusion).toEqual([])
  })
})

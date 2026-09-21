import { describe, expect, it } from 'vitest'

describe('the offline floor', () => {
  it('refuses a network call from inside the suite', async () => {
    // Not a convention: the suite must be unable to reach the network, so a
    // forgotten cassette fails loudly instead of quietly calling a provider
    // on a contributor's key (design 9.3, CONTRIBUTING).
    await expect(async () => fetch('https://api.example.com/v1/messages')).rejects.toThrow(
      /reached the network/,
    )
  })

  it('names how to record, since that is the one legitimate reason to want it', async () => {
    await expect(async () => fetch('https://api.example.com')).rejects.toThrow(
      /IDP_CASSETTE=record/,
    )
  })
})

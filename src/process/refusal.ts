/**
 * A vector outside a launcher's grammar (stage 6 brief § 6): a programming
 * error, never the user's, and nothing was started. It names the command word
 * and nothing else — an argument can hold a repository's content.
 */
export class LauncherRefusal extends Error {
  constructor(program: 'git' | 'gh', word: string) {
    super(`${program} ${word} is not a command idp-agent runs`)
    this.name = 'LauncherRefusal'
  }
}

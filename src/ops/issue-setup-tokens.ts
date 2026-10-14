import * as userService from '../modules/users/service.js'

/**
 * Where the web's "Definir senha" page lives; the token goes in the query string. The web
 * builds the same path from `setup.token` in the create-client response.
 */
export const SETUP_LINK_PATH = '/definir-senha'

export const setupLinkPath = (token: string) => `${SETUP_LINK_PATH}?token=${encodeURIComponent(token)}`

export interface IssueSetupTokensOptions {
  dryRun: boolean
  /** Receives each output line (CSV). Tokens are credentials: this is stdout, never a logger. */
  write: (line: string) => void
}

/**
 * One-off migration for P0-02: issues a password setup token to every CLIENT, so clients
 * created before setup tokens (with a random password nobody knows) can choose one before
 * `VERIFY_PASSWORDS` is turned on.
 *
 * Lists all clients via `ListUsers(role=CLIENT)`, not `ListUsersWithoutPassword`: legacy clients
 * have a random-UUID hash, so they don't show up as "without password". Issuing a token
 * invalidates the user's previous unused one, and anyone holding a link can set that user's
 * password, so run it once, at migration time, and hand each link only to its client.
 */
export async function issueSetupTokens({ dryRun, write }: IssueSetupTokensOptions): Promise<number> {
  const clients = await userService.listUsers('CLIENT')
  write(dryRun ? 'userId,email' : 'userId,email,linkPath,expiresAt')
  for (const client of clients) {
    if (dryRun) {
      write(`${client.id},${client.email}`)
      continue
    }
    const { token, expiresAt } = await userService.createPasswordSetupToken(client.id)
    write(`${client.id},${client.email},${setupLinkPath(token)},${expiresAt}`)
  }
  return clients.length
}

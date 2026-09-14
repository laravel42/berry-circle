/**
 * The sealing key every test that writes the GitHub App uses.
 *
 * `github_apps` holds one row for the whole deployment, so two test files that
 * each create an App share that row — and a random key per file would leave each
 * unable to open the private key the other sealed, which surfaces as "sealed
 * value could not be opened" only when the files happen to run together.
 *
 * Fixed, so whichever fixture wrote the row, any of them can read it. Test
 * support only; not a test file, and never a deployment's key.
 */
export const APP_SEALING_KEY = Buffer.alloc(32, 11).toString('base64');

import styles from './privacy-levels.module.css'

interface PrivacyLevel {
  readonly audience: string
  readonly reach: string
  readonly revoke: string
}

const REACH_LABEL = 'Who can open it'
const REVOKE_LABEL = 'How you take it back'
const CAPTION_ID = 'privacy-levels-caption'

const LEVELS: readonly PrivacyLevel[] = [
  {
    audience: 'Only me',
    reach: 'You, signed in as the owner. Not other members, and not admins either — the read check returns false for an admin on someone else’s private artifact.',
    revoke: 'Nothing to take back. Every new artifact starts here.',
  },
  {
    audience: 'Everyone on this instance',
    reach: 'Any active member of your instance, once signed in. Not the public internet, and not a search engine.',
    revoke: 'Set it back to Only me. The next request gets a 404, not a 403 — a stranger cannot learn the artifact exists.',
  },
  {
    audience: 'Anyone with the link',
    reach: 'Whoever holds the link, with no account and no sign-in. The link is pinned to one version, so the edits you make afterwards stay unpublished.',
    revoke: 'Revoke the link, or give it an expiry date when you create it. The page stops loading immediately; its assets stop within 60 seconds.',
  },
]

/**
 * Roles are spelled out because the narrow-viewport rules set `display: block` on the table
 * elements, which drops the implicit table semantics in Chromium.
 */
export function PrivacyLevels() {
  return (
    <table className={styles.table} role="table" aria-labelledby={CAPTION_ID}>
      <caption className={styles.caption} id={CAPTION_ID}>
        The three audiences an artifact can have, and how each one is withdrawn.
      </caption>
      <thead className={styles.head} role="rowgroup">
        <tr role="row">
          <th className={styles.columnHead} role="columnheader" scope="col">
            Audience
          </th>
          <th className={styles.columnHead} role="columnheader" scope="col">
            {REACH_LABEL}
          </th>
          <th className={styles.columnHead} role="columnheader" scope="col">
            {REVOKE_LABEL}
          </th>
        </tr>
      </thead>
      <tbody className={styles.body} role="rowgroup">
        {LEVELS.map((level) => (
          <tr className={styles.row} role="row" key={level.audience}>
            <th className={styles.audience} role="rowheader" scope="row">
              {level.audience}
            </th>
            <td className={styles.cell} role="cell" data-label={REACH_LABEL}>
              {level.reach}
            </td>
            <td className={styles.cell} role="cell" data-label={REVOKE_LABEL}>
              {level.revoke}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

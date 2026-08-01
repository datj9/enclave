/**
 * Append-only enforcement for `audit_log` (A.12.4.1: "logs must be retained and not deletable by
 * the application"). Two layers, because they cover different threats:
 *
 * 1. The trigger below refuses every UPDATE and every DELETE that has not opted in through
 *    `enclave.audit_prune`. It holds even in the default single-role deployment, where the app
 *    and the retention job share one Postgres role and a GRANT cannot tell them apart.
 * 2. `auditLogRoleGrantsDdl` revokes UPDATE and DELETE outright where the deployment runs the
 *    retention job as its own role — the stronger control, since the app cannot set the GUC.
 *
 * The trigger is intentionally not expressible in the Drizzle schema; it ships as DDL that the
 * central migration for `audit_log` applies after `create table`.
 */

/** A transaction sets this to `'on'` for the duration of a prune, and nothing else ever does. */
export const AUDIT_PRUNE_SETTING = 'enclave.audit_prune'

export const AUDIT_LOG_APPEND_ONLY_DDL = `
create or replace function audit_log_append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('${AUDIT_PRUNE_SETTING}', true) = 'on' then
    return old;
  end if;
  raise exception 'audit_log is append-only (attempted %)', tg_op using errcode = '42501';
end;
$$;

drop trigger if exists audit_log_no_update on audit_log;
create trigger audit_log_no_update
  before update on audit_log for each row execute function audit_log_append_only();

drop trigger if exists audit_log_no_delete on audit_log;
create trigger audit_log_no_delete
  before delete on audit_log for each row execute function audit_log_append_only();
`

/** Postgres identifiers are quoted, so a role name never reaches the statement unescaped. */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/**
 * For deployments that give the retention job its own role. `pruneRole` still needs the GUC, so
 * the trigger stays the backstop if the grant is ever widened by mistake.
 */
export function auditLogRoleGrantsDdl(appRole: string, pruneRole: string): string {
  const app = quoteIdentifier(appRole)
  const prune = quoteIdentifier(pruneRole)
  return [
    `revoke all on table audit_log from ${app};`,
    `grant insert, select on table audit_log to ${app};`,
    `grant usage, select on sequence audit_log_id_seq to ${app};`,
    `revoke all on table audit_log from ${prune};`,
    `grant select, delete on table audit_log to ${prune};`,
  ].join('\n')
}

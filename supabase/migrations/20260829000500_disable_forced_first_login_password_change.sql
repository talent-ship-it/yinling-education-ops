-- Staff should be able to learn the system with the password issued by the
-- administrator and choose when to change it themselves. Preserve password
-- hashes and credential versions; this changes only the login policy flag.
do $$
declare
  changed_count integer := 0;
begin
  update internal.app_account_credentials credential
  set must_change_password = false,
      updated_at = now(),
      updated_by = 'Nixon'
  from internal.app_accounts account
  where account.account_id = credential.account_id
    and account.status = 'active'
    and credential.enabled
    and credential.must_change_password;
  get diagnostics changed_count = row_count;

  if changed_count > 0 then
    perform internal.append_operational_contract_audit(
      'account.password_change_requirement_disabled_bulk',
      'Nixon',
      'account-policy',
      'active-accounts',
      jsonb_build_object('changedAccountCount', changed_count)
    );
  end if;
end;
$$;

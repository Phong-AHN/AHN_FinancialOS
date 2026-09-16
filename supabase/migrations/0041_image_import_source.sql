-- Transactions read from a screenshot of a Vietnamese banking app.
--
-- Its own source, not `csv_vn_bank` and not `vietinbank`, because provenance is
-- the thing spec section 28 asks every dollar to carry. A row an AI model read
-- off a picture, that a person then checked, is a different kind of evidence
-- from a row a bank's API returned or a bank's own export file contained — and
-- somebody auditing a figure later needs to be able to tell them apart without
-- opening the raw JSON.

do $$
begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'source_system' and e.enumlabel = 'image_vn_bank'
  ) then
    alter type source_system add value 'image_vn_bank';
  end if;
end
$$;

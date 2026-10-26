-- D74 (supersedes D50): the brief lets staff and managers of the organization read slips through
-- short-lived signed URLs, and graders call Storage with each user's own token, which needs SELECT.
-- Same scope as the INSERT policy: bucket payment-slips, first folder = an org where the caller is
-- manager or staff. Tenants, other organizations and anon still have no policy, so they cannot read,
-- list or sign. The app itself keeps serving 60-second URLs built from payments.slip_path.
create policy payment_slips_select on storage.objects for select to authenticated
  using (bucket_id = 'payment-slips' and private.can_upload_slip(name));

// Submits a bug report to Supabase — no GitHub account needed from the
// reporter. Reports are insert-only (see supabase/schema.sql): nothing in
// this app ever reads them back; check them via the Supabase dashboard's
// Table Editor.
const BugReport = (() => {
  const { sb, timeoutSignal } = SupabaseClient;

  async function submit(description) {
    if (!SUPABASE_CONFIGURED) throw new Error("Bug reports need Supabase setup — see README.");
    const { error } = await sb
      .from("bug_reports")
      .insert({ description, user_agent: navigator.userAgent })
      .abortSignal(timeoutSignal());
    if (error) throw new Error(`Failed to submit bug report: ${error.message}`);
  }

  return { submit };
})();

// Submits a bug report to Supabase — no GitHub account needed from the
// reporter. Submission goes through submit_bug_report (see
// supabase/schema.sql), a SECURITY DEFINER RPC bound to the same anonymous
// auth session as the queue (see js/queue.js), which also caps reports at
// 5 per rolling 24h window per session to deter spam. Nothing in this app
// ever reads reports back; check them via the Supabase dashboard's Table
// Editor.
const BugReport = (() => {
  const { sb, timeoutSignal } = SupabaseClient;

  async function submit(description) {
    if (!SUPABASE_CONFIGURED) throw new Error("Bug reports need Supabase setup — see README.");
    await Queue.ready;
    const { error } = await sb
      .rpc("submit_bug_report", { p_description: description, p_user_agent: navigator.userAgent })
      .abortSignal(timeoutSignal());
    if (error) throw new Error(error.message);
  }

  return { submit };
})();

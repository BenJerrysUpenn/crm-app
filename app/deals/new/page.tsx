import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import NewDealForm from "@/components/NewDealForm";

export const dynamic = "force-dynamic";

// /deals/new — add a deal for a customer who did not use the catering form.
//
// Reached from the "New deal" button on the board. The form itself is the call
// desk's guided form with no prospect behind it; see components/NewDealForm.
// RLS is the guard on the write, as everywhere else in this app — this page
// only checks that somebody is signed in, so an employee who is not a manager
// gets the form and a clean refusal from the route rather than a blank screen.
export default async function NewDealPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={user.email ?? ""} />
      <main className="flex-1 bg-slate-950">
        <NewDealForm callerEmail={user.email ?? ""} />
      </main>
    </div>
  );
}

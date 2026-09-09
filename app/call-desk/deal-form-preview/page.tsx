import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import DealFormPreview from "@/components/callDesk/DealFormPreview";

export const dynamic = "force-dynamic";

// Standalone review harness for the guided "Generate deal" form. The queue UI
// that normally opens it is being built on a separate branch (bj-finance
// #409), so this page mounts the form on a fake prospect to make it reviewable
// on its own. Delete it once the two branches are merged and the queue row's
// "Generate deal" button is the real entry point.
export default async function DealFormPreviewPage() {
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
        <DealFormPreview callerEmail={user.email ?? ""} />
      </main>
    </div>
  );
}

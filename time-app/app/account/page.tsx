import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import AccountForm from "@/components/AccountForm";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const profile = await getProfile();
  if (!profile) redirect("/login");

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
      <main className="flex-1">
        <div className="mx-auto max-w-md px-4 py-6">
          <AccountForm
            initialName={profile.full_name ?? ""}
            initialPhone={profile.phone ?? ""}
            profileId={profile.id}
            role={profile.role}
            initialPrefs={profile.notif_prefs ?? {}}
          />
        </div>
      </main>
    </div>
  );
}
